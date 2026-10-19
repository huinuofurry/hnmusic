// 定期清理游客数据 —— 行为验证（不只是测那个纯函数，而是**真的让它跑一遍**）。
//
// 用户 2026/10/16："加一个定期清理游客账号数据"。
// 做法：起隔离实例（HN_PRUNE_EVERY 调成 300ms），手工把库改成
//   · 游客 A：空队列 + 闲置 10 天   → 应该被清掉
//   · 游客 B：有 3 首歌 + 闲置 40 天 → 应该被清掉（连带队列）
//   · 管理员会话：闲置 999 天        → **不能**被动（登录用户不按闲置清）
// 然后等它自己那一轮跑完，再核对库。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hnmusic-prune-'));
const PORT = Number(process.env.HN_TEST_PORT) || 8094;
const B = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DB = path.join(DIR, 'db.json');
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

const boot = (extraEnv = {}) =>
    spawn(process.execPath, ['src/index.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HN_DATA_DIR: DIR, ...extraEnv },
        stdio: 'ignore',
    });
const stop = (p) =>
    new Promise((res) => {
        if (!p || p.exitCode !== null) return res();
        p.once('exit', res);
        p.kill();
        setTimeout(res, 3000);
    });
const waitUp = async () => {
    for (let i = 0; i < 40; i++) {
        try {
            await fetch(B + '/api/health');
            return true;
        } catch {
            await sleep(250);
        }
    }
    return false;
};
const post = async (p, body, token) => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(B + p, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
    return { status: r.status, data: await r.json().catch(() => null) };
};
const readDb = () => JSON.parse(fs.readFileSync(DB, 'utf8'));

let srv = null;
try {
    // 先把管理员造出来（CLI 不需要服务器在跑）
    spawnSync(process.execPath, ['scripts/admin.js', 'init', 'tester', '--password', 'test-pass-123'], {
        cwd: ROOT,
        env: { ...process.env, HN_DATA_DIR: DIR },
        stdio: 'ignore',
    });

    srv = boot();
    if (!(await waitUp())) throw new Error('实例没起来');

    // 造数据：三个游客 + 一个**真的登录**过的管理员会话
    //   A：空队列、闲置 10 天   → 清
    //   B：有歌、闲置 40 天     → 清
    //   C：有歌、闲置 10 天     → 也要清（用户 2026/10/16 明确"所有游客都 7 天没上线清"）
    const guestA = (await post('/api/auth/guest', {})).data.token; // 空队列
    // ⚠️ 队列是**懒创建**的：光领令牌不会有队列条目。
    //    用一次 /api/state 才会落一个空队列，这样下面的"连队列一起清"才是真检查
    await fetch(B + '/api/state', { headers: { Authorization: 'Bearer ' + guestA } });
    const guestB = (await post('/api/auth/guest', {})).data.token;
    await post('/api/queue/items', { bvid: 'BV1KEEPGUEST', cid: 'g', title: '游客B的歌', cover: '', duration: 100 }, guestB);
    const guestC = (await post('/api/auth/guest', {})).data.token;
    await post('/api/queue/items', { bvid: 'BV1KEEPGUESTC', cid: 'gc', title: '游客C的歌', cover: '', duration: 100 }, guestC);
    const adminLogin = await post('/api/auth/login', { username: 'tester', password: 'test-pass-123' });
    if (!adminLogin.data || !adminLogin.data.token) throw new Error('管理员登录失败，没法造"登录用户会话"');

    // ⚠️ 等 200ms 的写盘防抖落地再停：Windows 上 kill 是直接 TerminateProcess，
    //    不跑 SIGTERM 冲盘（这个坑今天栽过）；不等就会读到一份没更新的库 ✗
    await sleep(700);
    await stop(srv);

    // 手工改成年份久远的"闲置"，并**先确认数据真的在库里**（不然下面的断言会假绿）
    const db = readDb();
    const now = Date.now();
    const day = 86400e3;
    const count0 = db.sessions.length;
    const qcount0 = Object.keys(db.queues).length;
    ok(count0 >= 4 && qcount0 >= 3, '⓪ 前置：造出来的会话和队列确实写进库了', { sessions: count0, queues: qcount0 });
    for (const s of db.sessions) {
        const idle = s.token === guestA ? 10 : s.token === guestB ? 40 : s.token === guestC ? 10 : 999;
        s.createdAt = now - idle * day;
        if (s.token === guestA || s.token === guestB || s.token === guestC) s.lastSeenAt = now - idle * day;
        else if (s.lastSeenAt) s.lastSeenAt = now - idle * day;
    }
    fs.writeFileSync(DB, JSON.stringify(db, null, 2));
    console.log('  造好数据：游客A(空队列,闲置10天) / 游客B(有歌,闲置40天) / 游客C(有歌,闲置10天) / 管理员(闲置999天)');

    // 用 300ms 的清理周期起来，等它自己跑几轮
    srv = boot({ HN_PRUNE_EVERY: '300' });
    if (!(await waitUp())) throw new Error('实例第二次没起来');
    await sleep(1800);

    // 清完之后盘上也干净了。
    // ⚠️ 这条**证明不了"定时那一轮自己写了盘"** —— 启动时那一次清理做的是同一件事，
    //    文件在启动时就已经干净了。我试过把 pruneQueues 的返回值改坏来验证它会红，
    //    **没红** ✗（假绿的另一种样子：断言通过，但通过的原因不是它想说的那个）。
    //    所以这里只声称它真正能证明的：清完以后盘上没有那两个游客了。
    const onDisk = readDb();
    ok(
        !onDisk.sessions.some((s) => s.token === guestA || s.token === guestB),
        '⓪b 清完之后盘上也干净（启动那轮或定时那轮清的都可能）',
        onDisk.sessions.length
    );

    await stop(srv); // 再停下来核对最终状态
    const after = readDb();
    const tokens = after.sessions.map((s) => s.token);
    const qkeys = Object.keys(after.queues);

    ok(!tokens.includes(guestA), '① 空队列的游客（闲置 10 天）被清掉了');
    ok(!tokens.includes(guestB), '② 有歌的游客（闲置 40 天）被清掉了');
    ok(!tokens.includes(guestC), '③ 有歌的游客（闲置 10 天）也清掉了（用户要求所有游客一律 7 天）');
    ok(
        !qkeys.includes('s:' + guestA) && !qkeys.includes('s:' + guestB) && !qkeys.includes('s:' + guestC),
        '④ 他们的队列也一起清了（不留孤儿）',
        qkeys
    );
    ok(after.sessions.length === 1, '⑤ 只剩管理员那一个会话（登录用户不按闲置清）', after.sessions.length);
    ok(
        after.users.some((u) => u.username === 'tester'),
        '⑥ 用户本身一个没动（清的是会话/队列，不是账号）'
    );

    // ---------- ⑦ 登录用户的令牌要**滑动续期**（用户 2026/10/17：想一直保持登录）----------
    // 起实例 → 把某用户会话的有效期改成"只剩 1 天" → 用它访问一次
    // ⇒ 有效期应被推到 ~1 年 ✓；同时**游客不续期**（他们有"7 天没上线就清"的规则 ✗）
    {
        const day = 86400e3;
        // ⚠️ 别再用 admin.js init 造第二个用户 —— 它**只能初始化一次** ✗
        //    （我第一次就是这么写的：init slide 静默失败 ⇒ 登录失败 ⇒ tk 是 undefined
        //     ⇒ 后继断言 200 也被"匿名 200"骗过去了 ✗ 典型的假绿）
        //    直接用本测试里早就建好的 tester ✓
        srv = boot();
        if (!(await waitUp())) throw new Error('实例（续期测试）没起来');
        const loginRes = await post('/api/auth/login', { username: 'tester', password: 'test-pass-123' });
        const userTok = loginRes.data && loginRes.data.token;
        ok(!!userTok, '⑦ 前置：能用 tester 登录拿到令牌（不是 undefined）', loginRes.status);
        const guestTok = (await post('/api/auth/guest', {})).data.token;
        await sleep(700);
        await stop(srv);

        const db2 = readDb();
        for (const s of db2.sessions) {
            if (s.token === userTok || s.token === guestTok) s.expiresAt = Date.now() + day;
        }
        fs.writeFileSync(DB, JSON.stringify(db2, null, 2));
        const uBefore = readDb().sessions.find((x) => x.token === userTok);
        ok(
            !!uBefore && uBefore.expiresAt - Date.now() < 2 * day,
            '⑦ 前置：用户令牌的有效期确实只剩 1 天',
            uBefore && Math.round((uBefore.expiresAt - Date.now()) / day) + ' 天'
        );

        srv = boot();
        if (!(await waitUp())) throw new Error('实例（续期测试第二次）没起来');
        const useUser = await fetch(B + '/api/auth/me', { headers: { Authorization: 'Bearer ' + userTok } });
        const useData = await useUser.json().catch(() => null);
        // ⚠️ 只看状态码会被"匿名/游客 200"骗过 ✗ 必须确认这次请求**认出了这个账号** ✓
        //    （我第一次用 /api/state 判断，那个接口对游客也返回 200，于是断言毫无意义 ✗）
        ok(
            useUser.status === 200 && !!(useData && useData.user && useData.session),
            '⑦ 用这个令牌访问一次，而且服务端认出了这个账号',
            useUser.status + ' user=' + !!(useData && useData.user)
        );
        await fetch(B + '/api/state', { headers: { Authorization: 'Bearer ' + guestTok } });
        await sleep(700);
        await stop(srv);

        const after2 = readDb().sessions;
        const uA = after2.find((x) => x.token === userTok);
        const gA = after2.find((x) => x.token === guestTok);
        const uDays = uA ? (uA.expiresAt - Date.now()) / day : 0;
        const gDays = gA ? (gA.expiresAt - Date.now()) / day : 0;
        ok(uDays > 300, '⑦ 登录用户：用过一次就续到约 1 年（以后不用再登录）', Math.round(uDays) + ' 天');
        ok(gDays < 2, '⑦ 游客：**不**续期（"7 天没上线就清"的规则要保持有效）', Math.round(gDays) + ' 天');
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
