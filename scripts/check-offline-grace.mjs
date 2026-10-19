// 离线宽限的行为验证（会自己起一个隔离的服务实例、自己关掉）。
//
// 用户 2026/10/15 要求：「设置离线后 60 秒没上线再自动退出」。
//
// 原来的实现有两个毛病，都因为"成员是从活跃 SSE 连接实时算出来的"：
//   ① 一断线就立刻从成员列表消失 —— 房主刷新一下页面，位子当场被顶
//   ② 空房回收也跟着活跃连接数走（5 秒）—— 手机切个 App 回来房间已经没了
//
// 现在：断线先记一笔"缺席"，60 秒内还算成员（并标 offline），超时才真踢。
//
// 跑得快靠 HN_OFFLINE_TTL / HN_EMPTY_ROOM_TTL 覆盖；数据目录用 HN_DATA_DIR 隔离，
// 既不碰开发用的 data/db.json，也不跟正在跑的那个进程抢单实例锁。
//
// 用法：node scripts/check-offline-grace.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TTL = 900; // 毫秒，宽限
const PORT = Number(process.env.HN_TEST_PORT) || 8099;
const B = 'http://127.0.0.1:' + PORT;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hnmusic-offline-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (cond, label, extra) => {
    if (cond) {
        pass++;
        console.log('OK   ' + label);
    } else {
        fail++;
        console.log('FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
    }
};

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const srv = spawn(process.execPath, [path.join(root, 'src', 'index.js')], {
    cwd: root,
    env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        HN_DATA_DIR: DIR,
        HN_OFFLINE_TTL: String(TTL),
        HN_EMPTY_ROOM_TTL: String(TTL),
    },
    stdio: 'ignore',
});

const guest = async () =>
    (await (await fetch(B + '/api/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).token;
const post = async (p, body, token) => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(B + p, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
    return { status: r.status, data: await r.json().catch(() => null) };
};
const getRoom = async (rid, token) => (await (await fetch(B + '/api/rooms/' + rid, { headers: { Authorization: 'Bearer ' + token } })).json());
// 开一条 SSE；关掉它（abort）就等于"断线"
const connect = async (rid, token) => {
    const ac = new AbortController();
    const res = await fetch(B + '/api/rooms/' + rid + '/events', { headers: { Authorization: 'Bearer ' + token }, signal: ac.signal });
    const rd = res.body.getReader();
    (async () => {
        try {
            for (;;) {
                const { done } = await rd.read();
                if (done) break;
            }
        } catch {
            /* 断了正常 */
        }
    })();
    return ac;
};

try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
        try {
            await fetch(B + '/api/health');
            up = true;
        } catch {
            await sleep(250);
        }
    }
    if (!up) throw new Error('测试实例没起来（端口 ' + PORT + ' 被占？）');

    const A = await guest();
    const Bt = await guest();
    const room = (await post('/api/rooms', { name: '离线测试房' }, A)).data;
    const rid = room.roomId;

    const acA = await connect(rid, A);
    await sleep(150);
    const acB = await connect(rid, Bt);
    await sleep(250);

    let ms = (await getRoom(rid, A)).members;
    ok(ms.length === 2, '两个人都在', ms.map((m) => m.key));
    ok(ms.every((m) => !m.offline), '在线的人不带 offline 标记');

    // 房主 A 断线
    acA.abort();
    await sleep(300);
    const r2 = await getRoom(rid, Bt);
    ms = r2.members;
    ok(ms.length === 2, '房主断线后**还在成员表里**（宽限期内）', ms.map((m) => [m.key, !!m.offline]));
    ok(ms.some((m) => m.offline), '断线的人被标成 offline: true');
    ok(r2.hostId === room.hostId, '宽限期内**房主没被换掉**（刷新页面回来还是房主）', r2.hostId);

    // 等宽限过期
    await sleep(TTL + 250);
    const r3 = await getRoom(rid, Bt);
    ms = r3.members;
    ok(ms.length === 1, '宽限到期后断线的人被移出成员表', ms.map((m) => m.key));
    ok(r3.hostId !== room.hostId && r3.hostId === ms[0].key, '房主超时没回来 → 位子交给还在的人', {
        原来: room.hostId,
        现在: r3.hostId,
        还在的人: ms[0].key,
    });

    // 所有人都断线
    acB.abort();
    await sleep(300);
    const alive = await getRoom(rid, Bt);
    ok(!alive.error, '所有人都断线后，宽限期内房间还在（不会一断就删）', alive.error);
    ok((alive.members || []).length === 1 && alive.members[0].offline, '最后一个人也只是标成离线', alive.members);

    // 等所有人都过期 + 空房回收
    // ⚠️ tick 每秒才跑一次，加上空房 TTL，要留够（我第一次写 2200ms 就差一点）
    await sleep(TTL * 2 + 2200);
    const gone = await getRoom(rid, Bt);
    ok(!!gone.error, '人都走光且宽限过期后，房间被回收', gone.error);
} catch (e) {
    fail++;
    console.log('FAIL 测试自身出错: ' + e.message);
} finally {
    srv.kill();
    await sleep(200);
    fs.rmSync(DIR, { recursive: true, force: true });
    console.log('');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}
