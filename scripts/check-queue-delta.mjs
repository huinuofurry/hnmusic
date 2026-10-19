// 房间队列：验证"只发增量"这套协议 —— 而且是**真的按客户端那套逻辑应用一遍**，
// 再跟服务端的队列比对，确保两边算出同一个结果（协议改了最容易在这里出错）。
//
// 为什么要这么测：以前每个队列事件都带整份队列（简单、不会错）；
// 现在改成增量（加/删/重排/清空分别应用），**服务端和客户端必须严格对得上** ——
// 所以这里独立实现一遍客户端的应用逻辑，喂给同一串事件，最后逐项比对。
//
//   node scripts/check-queue-delta.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hnmusic-delta-'));
const PORT = Number(process.env.HN_TEST_PORT) || 8097;
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
const getRoom = async (rid, token) => (await (await fetch(B + '/api/rooms/' + rid, { headers: { Authorization: 'Bearer ' + token } })).json());

// ---- 客户端那套应用逻辑（照 public/index.html 里 queue-* 分支写的） ----
function applyDelta(lq, event, data) {
    if (data.queue) return { ...data.queue };
    if (data.cleared) return { ...lq, items: [] };
    let items = lq.items.slice();
    if (Array.isArray(data.items)) {
        items.push(...data.items);
    } else if (data.item) {
        if (data.moved || data.afterId !== undefined) {
            const at = items.findIndex((x) => x.id === data.item.id);
            if (at >= 0) items.splice(at, 1);
            const anchor = data.afterId ? items.findIndex((x) => x.id === data.afterId) : -1;
            if (data.afterId && anchor < 0) items.push(data.item);
            else items.splice(anchor + 1, 0, data.item);
        } else {
            items.push(data.item);
        }
    } else if (data.itemId) {
        items = items.filter((x) => x.id !== data.itemId);
    } else if (Array.isArray(data.order)) {
        const byId = new Map(items.map((x) => [x.id, x]));
        const next = [];
        for (const id of data.order) {
            const it = byId.get(id);
            if (it) {
                next.push(it);
                byId.delete(id);
            }
        }
        for (const it of byId.values()) next.push(it);
        items = next;
    }
    const out = { ...lq, items };
    if (data.currentId !== undefined) out.currentId = data.currentId;
    return out;
}

let srv = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HN_DATA_DIR: DIR },
    stdio: 'ignore',
});
const stop = () =>
    new Promise((res) => {
        if (srv.exitCode !== null) return res();
        srv.once('exit', () => res());
        srv.kill();
        setTimeout(res, 3000);
    });

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
    if (!up) throw new Error('实例没起来');

    const host = (await post('/api/auth/guest', {})).data.token;
    const room = (await post('/api/rooms', { name: '增量协议测试房' }, host)).data;
    const rid = room.roomId;

    // 挂一条 SSE，收下所有 queue-* 事件
    const events = [];
    const ac = new AbortController();
    const stream = await fetch(B + '/api/rooms/' + rid + '/events', { headers: { Authorization: 'Bearer ' + host }, signal: ac.signal });
    const reader = stream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pump = (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let at;
                while ((at = buf.indexOf('\n\n')) >= 0) {
                    const raw = buf.slice(0, at);
                    buf = buf.slice(at + 2);
                    const ev = (raw.match(/^event: (.*)$/m) || [])[1];
                    const dt = (raw.match(/^data: (.*)$/m) || [])[1];
                    if (ev) events.push({ ev, data: dt ? JSON.parse(dt) : {} });
                }
            }
        } catch {
            /* abort */
        }
    })();

    const track = (i) => ({ bvid: 'BV1DELTA00' + i, cid: 'd' + i, title: '增量' + i, cover: '', duration: 100 });
    const ctl = (body) => post('/api/rooms/' + rid + '/control', body, host);

    // 1) 加 5 首
    await ctl({ action: 'queue-add-batch', tracks: [1, 2, 3, 4, 5].map(track) });
    await sleep(300);
    // 2) 每首事件里**不能**带整份队列
    const batchEv = events.filter((e) => e.ev === 'queue-add');
    const sizes = batchEv.map((e) => JSON.stringify(e.data).length);
    ok(
        batchEv.length > 0 && sizes.every((s) => s < 2000),
        '① 批量加歌的事件里没有整份队列（每条都 < 2KB）',
        { 条数: batchEv.length, 最大字节: Math.max(...sizes) }
    );
    ok(batchEv.some((e) => Array.isArray(e.data.items)), '① 批量加是 {items:[...]} 这种增量');

    // 3) 再单加一首（会 append），事件应该只有 {item, afterId}
    await ctl({ action: 'queue-add', ...track(6) });
    await sleep(300);
    const oneEv = events.filter((e) => e.ev === 'queue-add' && e.data.item).slice(-1)[0];
    ok(!!oneEv && oneEv.data.item.title === '增量6' && oneEv.data.afterId !== undefined, '② 单加一首发的是 {item, afterId}', oneEv && oneEv.data);

    // 4) 【下一位】把第 6 首挪到当前后面
    const st0 = await getRoom(rid, host);
    const sixth = st0.queue.items.find((x) => x.title === '增量6');
    await ctl({ action: 'queue-move', itemId: sixth.id, toNext: true });
    await sleep(300);
    // 5) 删一首
    const second = st0.queue.items.find((x) => x.title === '增量2');
    await ctl({ action: 'queue-remove', itemId: second.id });
    await sleep(300);
    const rmEv = events.filter((e) => e.ev === 'queue-remove').slice(-1)[0];
    ok(!!rmEv && !!rmEv.data.itemId && rmEv.data.currentId !== undefined && !rmEv.data.queue, '③ 删除只发 {itemId, currentId}', rmEv && Object.keys(rmEv.data));

    // 6) 关键：把收到的**所有** queue-* 事件按客户端逻辑应用一遍，看是否和服务端一致
    let local = { items: [], currentId: null, mode: 'sequence' };
    for (const e of events) {
        if (e.ev === 'state') local = { ...e.data.queue };
        else if (e.ev.startsWith('queue-')) local = applyDelta(local, e.ev, e.data);
    }
    const server = await getRoom(rid, host);
    const sameOrder = local.items.map((x) => x.id).join(',') === server.queue.items.map((x) => x.id).join(',');
    const sameCur = local.currentId === server.queue.currentId;
    ok(sameOrder, '④ 自己按增量算出来的顺序和服务端一致', {
        本地: local.items.map((x) => x.title),
        服务端: server.queue.items.map((x) => x.title),
    });
    ok(sameCur, '④ 当前曲目也一致', { 本地: local.currentId, 服务端: server.queue.currentId });

    // 7) 重排只发顺序：1000 首的 order 应该远小于整份队列
    const big = [];
    for (let i = 0; i < 400; i++) big.push({ bvid: 'BV1BIGD' + i, cid: 'b' + i, title: '大批量' + i, cover: '', duration: 100 });
    await ctl({ action: 'queue-add-batch', tracks: big });
    await sleep(400);
    const before = events.length;
    const stBig = await getRoom(rid, host);
    const last = stBig.queue.items[stBig.queue.items.length - 1];
    await ctl({ action: 'queue-reorder', itemId: last.id, toIndex: 0 });
    await sleep(400);
    const reEv = events.slice(before).filter((e) => e.ev === 'queue-reorder').slice(-1)[0];
    const reSize = reEv ? JSON.stringify(reEv.data).length : -1;
    const fullSize = JSON.stringify(stBig.queue).length;
    ok(reEv && Array.isArray(reEv.data.order), '⑤ 重排发的是 {order:[id...]}', reEv && Object.keys(reEv.data));
    ok(reSize > 0 && reSize < fullSize / 10, '⑤ 重排报文比整份队列小一个数量级以上', {
        order报文: reSize + ' 字节',
        整份队列: Math.round(fullSize / 1024) + ' KB',
        倍数: Math.round(fullSize / reSize) + '×',
    });

    // 8) 清空
    await ctl({ action: 'queue-clear' });
    await sleep(300);
    const clEv = events.filter((e) => e.ev === 'queue-clear').slice(-1)[0];
    ok(!!clEv && clEv.data.cleared === true, '⑥ 清空只发 {cleared:true}', clEv && clEv.data);

    ac.abort();
    await pump.catch(() => {});
} catch (e) {
    fail++;
    console.log('FAIL 测试自身出错: ' + e.message);
} finally {
    await stop();
    await sleep(200);
    fs.rmSync(DIR, { recursive: true, force: true });
    console.log('');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}
