#!/usr/bin/env node
// 管理端命令行 —— 项目的"引导通道"。
// 故意不做成 HTTP 接口：网络上不存在任何"能凭空造出管理员 / 邀请码"的入口。
// 日常发码请用管理员接口（网页上登录管理员 → 生成），这里主要负责第一次引导和救急。
//
//   node scripts/admin.js init <用户名>      建第一个管理员，并顺手发一个邀请码
//   node scripts/admin.js invite [--days N]  发一个邀请码
//   node scripts/admin.js invites            列出所有邀请码
//   node scripts/admin.js revoke <邀请码>     吊销一个未使用的邀请码
//   node scripts/admin.js passwd <用户名>     改密码（同时清掉该用户所有令牌）
//
// 密码：交互式下隐藏输入；脚本/自动化可用 --password <值>，或从管道喂一行。
import process from 'node:process';
import * as readline from 'node:readline/promises';
import * as store from '../src/store.js';
import * as auth from '../src/auth.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

function flag(name) {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] ?? null : null;
}
// 去掉 --flag 和它后面跟着的值，剩下的就是位置参数
function positional() {
    return rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
}

function usage() {
    console.log(`用法：
  node scripts/admin.js init <用户名>       建第一个管理员，并顺手发一个邀请码
  node scripts/admin.js invite [--days N]   发一个邀请码
  node scripts/admin.js invites             列出所有邀请码
  node scripts/admin.js revoke <邀请码>      吊销一个未使用的邀请码
  node scripts/admin.js passwd <用户名>      改密码（会清掉该用户所有令牌）

可选：--password <值> 非交互式提供密码（会留在命令历史里，尽量用交互输入或管道）`);
}

function askHidden(prompt) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        process.stdout.write(prompt);
        stdin.resume();
        stdin.setRawMode(true);
        let buf = '';
        const done = (val) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            resolve(val);
        };
        const onData = (chunk) => {
            for (const ch of chunk.toString('utf8')) {
                if (ch === '\r' || ch === '\n') return done(buf);
                if (ch === '\u0003') {
                    process.stdout.write('\n');
                    process.exit(130);
                }
                if (ch === '\u007f' || ch === '\b') {
                    buf = buf.slice(0, -1);
                    continue;
                }
                if (ch >= ' ') {
                    buf += ch;
                    process.stdout.write('*');
                }
            }
        };
        stdin.on('data', onData);
    });
}

async function askPassword() {
    const fromFlag = flag('--password');
    if (fromFlag) return fromFlag;
    if (!process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin });
        const line = await rl.question('');
        rl.close();
        return line.trim();
    }
    return askHidden('密码: ');
}

// 服务在跑的时候，它内存里也有一份数据库副本，它下次保存会覆盖掉命令行的改动
async function warnIfServerRunning() {
    try {
        const r = await fetch('http://localhost:8080/api/state', { signal: AbortSignal.timeout(800) });
        if (r.ok) {
            console.log('⚠  检测到服务正在运行（http://localhost:8080）。');
            console.log('   服务内存里也有一份数据，它下次保存会覆盖掉本次改动。');
            console.log('   建议先停掉服务，或改用网页上的管理员接口发码。\n');
        }
    } catch {
        /* 服务没在跑，正常情况 */
    }
}

async function main() {
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return usage();

    store.load();
    auth.pruneSessions();

    if (cmd === 'init') {
        const username = positional()[0];
        if (!username) throw new Error('用法: node scripts/admin.js init <用户名>');
        if (auth.countUsers() > 0) {
            throw new Error('库里已经有用户了。init 只用于第一次建管理员；要加人请用 invite 发邀请码让对方自己注册');
        }
        await warnIfServerRunning();
        const password = await askPassword();
        const user = auth.createUser({ username, password, role: 'admin', status: 'active' });
        // M2 时代建的歌单没有主人（ownerId = null）。M3 起歌单完全私有，
        // 不接管的话这些歌单会在界面上彻底消失 —— 交给第一个管理员。
        const adopted = store.getDb().playlists.filter((p) => p.ownerId === null);
        for (const pl of adopted) pl.ownerId = user.id;
        // M2 只有一个全局队列（存成 'legacy'），现在队列每人一份，也交给第一个管理员
        const queue = store.getDb().queues.legacy;
        let queueCount = 0;
        if (queue && Array.isArray(queue.items) && queue.items.length) {
            store.getDb().queues['u:' + user.id] = queue;
            delete store.getDb().queues.legacy;
            queueCount = queue.items.length;
        }
        const inv = auth.createInvite({ createdBy: user.id });
        store.flush();
        console.log(`已创建管理员: ${user.username} (${user.id})`);
        if (adopted.length) {
            console.log(`已接管 ${adopted.length} 个无主歌单: ${adopted.map((p) => p.name).join('、')}`);
        }
        if (queueCount) {
            console.log(`已接管旧的全局队列（${queueCount} 首），现在队列每人一份`);
        }
        console.log(`第一个邀请码: ${inv.code}`);
        console.log('把这个邀请码发给朋友，让他在网页上注册。');
        return;
    }

    const adminUser = store.getDb().users.find((u) => u.role === 'admin') || null;

    if (cmd === 'invite') {
        await warnIfServerRunning();
        const inv = auth.createInvite({
            createdBy: adminUser ? adminUser.id : null,
            expiresInDays: flag('--days'),
        });
        store.flush();
        const tail = inv.expiresAt
            ? `（${Math.round((inv.expiresAt - Date.now()) / 86400e3)} 天后过期）`
            : '（永不过期）';
        console.log(`邀请码: ${inv.code}${tail}`);
        return;
    }

    if (cmd === 'invites') {
        const list = auth.listInvites();
        if (!list.length) {
            console.log('（还没有邀请码）');
            return;
        }
        const label = { unused: '未使用', used: '已使用', revoked: '已吊销', expired: '已过期' };
        for (const inv of list) {
            const who = inv.usedBy ? store.getDb().users.find((u) => u.id === inv.usedBy) : null;
            console.log(
                `${inv.code}  ${label[inv.status] ?? inv.status}${who ? ' → ' + who.username : ''}  ${new Date(inv.createdAt).toLocaleString()}`
            );
        }
        return;
    }

    if (cmd === 'revoke') {
        const code = positional()[0];
        if (!code) throw new Error('用法: node scripts/admin.js revoke <邀请码>');
        await warnIfServerRunning();
        const inv = auth.revokeInvite(code);
        store.flush();
        console.log(`已吊销: ${inv.code}`);
        return;
    }

    if (cmd === 'passwd') {
        const username = positional()[0];
        if (!username) throw new Error('用法: node scripts/admin.js passwd <用户名>');
        const user = auth.findUserByName(username);
        if (!user) throw new Error(`没有这个用户: ${username}`);
        await warnIfServerRunning();
        const password = await askPassword();
        const r = auth.changePassword(user.id, password);
        store.flush();
        console.log(`已改密码: ${user.username}，同时清掉该用户 ${r.killedSessions} 个令牌`);
        return;
    }

    usage();
    process.exitCode = 1;
}

main().catch((e) => {
    // 只打印消息本身，绝不回显密码等输入内容
    console.error(`错误: ${e.message}`);
    process.exitCode = 1;
});
