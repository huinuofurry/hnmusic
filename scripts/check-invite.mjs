// 邀请码：用掉就删，而且**不能影响已注册用户**。
//
// 用户 2026/10/16：「邀请码使用过的自动删除就行了，要求删除了的邀请码不会影响
// 已经注册的用户」。这个担心很合理 —— 所以这里把两件事都验了：
//   ① 用过的邀请码确实从列表里消失了
//   ② 用那个码注册出来的用户**照样能登录、数据还在**（删码不影响用户）
//
// 自己起一个隔离实例（HN_DATA_DIR + 独立端口），跑完自己关掉。
// 用法：node scripts/check-invite.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 只为了拿 shouldPruneGuestSession 那个纯函数（import 不会碰 data/，
// 真正读库是 store.load()，测试进程不会调）
import * as authMod from '../src/auth.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hnmusic-invite-'));
const PORT = Number(process.env.HN_TEST_PORT) || 8096;
const B = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (c, label, extra) => {
    if (c) {
        pass++;
        console.log('OK   ' + label);
    } else {
        fail++;
        console.log('FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
    }
};

const post = async (p, body, token) => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(B + p, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
    return { status: r.status, data: await r.json().catch(() => null) };
};
const get = async (p, token) => {
    const h = {};
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(B + p, { headers: h });
    return { status: r.status, data: await r.json().catch(() => null) };
};
const boot = () =>
    spawn(process.execPath, ['src/index.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HN_DATA_DIR: DIR },
        stdio: 'ignore',
    });

let srv = boot();
// ⚠️ 停服务要**等它真的退出**，不能 sleep 一下就动手改库：
//    进程退出时会把自己内存里那份 db flush 到磁盘，
//    这时候正好被我的改动覆盖/反过来覆盖我的改动（第一次就是这么翻车的：
//    手写的"旧邀请码"记录被 flush 冲掉，连带把用户也弄没了 → 断言 ⑦ 假失败）
const stop = (p) =>
    new Promise((res) => {
        if (!p || p.exitCode !== null) return res();
        p.once('exit', () => res());
        p.kill();
        setTimeout(res, 3000); // 兜底：3 秒还没退就继续
    });
try {
    // ① 先造一个管理员（admin.js init 会顺手发一个邀请码）
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
        try {
            await fetch(B + '/api/health');
            up = true;
        } catch {
            await sleep(250);
        }
    }
    if (!up) throw new Error('实例没起来（端口被占？）');
    await stop(srv);
    const cli = spawnSync(process.execPath, ['scripts/admin.js', 'init', 'tester', '--password', 'test-pass-123'], {
        cwd: ROOT,
        env: { ...process.env, HN_DATA_DIR: DIR },
        stdio: 'ignore',
    });
    ok(cli.status === 0, '① 造出管理员（admin.js init，顺手发了一个邀请码）', cli.status);
    srv = boot();
    up = false;
    for (let i = 0; i < 40 && !up; i++) {
        try {
            await fetch(B + '/api/health');
            up = true;
        } catch {
            await sleep(250);
        }
    }

    const admin = (await post('/api/auth/login', { username: 'tester', password: 'test-pass-123' })).data.token;
    ok(!!admin, '② 管理员登录成功');

    let invites = (await get('/api/admin/invites', admin)).data.invites;
    ok(invites.length === 1 && invites[0].status === 'unused', '② 手上有 1 个没用过的邀请码', invites.map((i) => i.status));
    const code = invites[0].code;

    // ③ 用它注册一个新用户
    const reg = await post('/api/auth/register', {
        username: 'newbie',
        displayName: '新来的',
        password: 'newbie-pass-123',
        inviteCode: code,
    });
    ok(reg.status === 200 && !!reg.data.token, '③ 用邀请码注册成功', { status: reg.status, err: reg.data && reg.data.error });
    const newbie = reg.data.token;

    // ④ 关键：邀请码应该**没了**
    invites = (await get('/api/admin/invites', admin)).data.invites;
    ok(!invites.some((i) => i.code === code), '④ 用过的邀请码已经从列表里消失了（自动删除）', invites.map((i) => i.code));

    // ⑤ 关键：新用户**照样能登录**，数据还在
    const relogin = await post('/api/auth/login', { username: 'newbie', password: 'newbie-pass-123' });
    ok(relogin.status === 200 && !!relogin.data.token, '⑤ 删码之后新用户照样能登录', relogin.status);
    const st = await get('/api/state', relogin.data.token);
    ok(st.status === 200 && st.data && Array.isArray(st.data.playlists), '⑤ 他的数据还在（/api/state 正常）', st.status);
    // 给他塞一首歌，确认能正常写
    const q = await post('/api/queue/items', { bvid: 'BV1Aupg64ECJ', cid: '', title: '新用户的歌', cover: '', duration: 100 }, newbie);
    ok(q.status === 200, '⑤ 新用户还能正常用自己的队列', q.status);

    // ⑥ 同一个码不能再用
    const reuse = await post('/api/auth/register', { username: 'newbie2', displayName: 'x', password: 'pass123456', inviteCode: code });
    ok(reuse.status === 403 && /邀请码无效/.test(reuse.data.error || ''), '⑥ 同一个码不能再用（403 邀请码无效）', reuse.data);

    // ⑦ 重启一次：老数据的 usedBy 记录要在启动时被清掉，且用户不受影响
    //
    // ⚠️ 停之前必须**让 200ms 的防抖落盘**：
    //    store.save() 是防抖的，而 Windows 上 child.kill() 是直接 TerminateProcess
    //    （不跑 SIGTERM 回调，也不跑 exit 回调）—— 立刻杀进程的话，
    //    刚才那次注册只存在于内存里，重启后就"没注册过"了 ✗
    //    （服务器是 Linux，systemd 发的 SIGTERM 由 store.js 里的信号处理负责冲盘 ✓
    //      这两件事是两回事，别混。）
    await sleep(500);
    await stop(srv);
    // 手动往库里塞一条"用过但还留着"的记录，模拟旧数据
    const dbFile = path.join(DIR, 'db.json');
    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    db.invites.push({ code: 'OLDSCHOOL1', createdBy: 'u1', createdAt: Date.now(), expiresAt: null, usedBy: 'u2', usedAt: Date.now(), revokedAt: null });
    fs.writeFileSync(dbFile, JSON.stringify(db));
    srv = boot();
    up = false;
    for (let i = 0; i < 40 && !up; i++) {
        try {
            await fetch(B + '/api/health');
            up = true;
        } catch {
            await sleep(250);
        }
    }
    const admin2 = (await post('/api/auth/login', { username: 'tester', password: 'test-pass-123' })).data.token;
    const invites2 = (await get('/api/admin/invites', admin2)).data.invites;
    ok(!invites2.some((i) => i.code === 'OLDSCHOOL1'), '⑦ 启动时清掉"用过但留着"的旧记录', invites2.map((i) => i.code));
    const relogin2 = await post('/api/auth/login', { username: 'newbie', password: 'newbie-pass-123' });
    ok(relogin2.status === 200, '⑦ 那次清理之后，已注册用户仍然能登录', relogin2.status);
    const st2 = await get('/api/state', relogin2.data.token);
    ok(st2.status === 200 && Array.isArray(st2.data.playlists), '⑦ 数据一条没少', st2.status);

    // ---------- 附：游客闲置清理的判据（纯函数，不联网）----------
    // 用户 2026/10/16："加一个定期清理游客账号数据"，并明确
    // **"所有游客都 7 天没上线清"**（不分有没有歌；登录用户不按闲置清）。
    {
        const now = Date.now();
        const day = 86400e3;
        const sess = (idleDays, withSeen = true) => ({
            userId: null,
            createdAt: now - idleDays * day,
            ...(withSeen ? { lastSeenAt: now - idleDays * day } : {}),
        });
        const songs = (n) => ({ items: new Array(n).fill({ bvid: 'BV1x' }) });
        const t = (idleDays, n) => authMod.shouldPruneGuestSession(sess(idleDays), songs(n), now);
        ok(t(8, 0) === true, '游客清理：空队列闲置 8 天 → 清掉');
        ok(t(6, 0) === false, '游客清理：空队列闲置 6 天 → 留着');
        ok(t(8, 5) === true, '游客清理：**有歌**闲置 8 天 → 也清掉（用户要求所有游客一律 7 天）');
        ok(t(6, 5) === false, '游客清理：有歌闲置 6 天 → 留着');
        ok(
            authMod.shouldPruneGuestSession({ userId: 'u1', createdAt: now - 999 * day, lastSeenAt: now - 999 * day }, null, now) === false,
            '游客清理：登录用户再久也不清（不能被"几天没上"踢下线）'
        );
        ok(
            authMod.shouldPruneGuestSession(sess(40, false), { items: [] }, now) === true,
            '游客清理：没有 lastSeenAt 的老数据退回 createdAt'
        );
        // 有 lastSeenAt 时以它为准（哪怕 createdAt 很老 —— 老会话后来还在用）
        ok(
            authMod.shouldPruneGuestSession({ userId: null, createdAt: now - 99 * day, lastSeenAt: now - 1 * day }, songs(3), now) === false,
            '游客清理：看的是"最后活跃"，不是注册时间（老账号最近还来过就留）'
        );
        ok(authMod.shouldPruneGuestSession(null, null, now) === false, '游客清理：null 不崩');
    }
} catch (e) {
    fail++;
    console.log('FAIL 测试自身出错: ' + e.message);
} finally {
    await stop(srv);
    fs.rmSync(DIR, { recursive: true, force: true });
    console.log('');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}
