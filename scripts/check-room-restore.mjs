import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hnmusic-restore-'));
const PORT = 8098;
const B = 'http://127.0.0.1:' + PORT;
const ROOT = 'F:/hnmusic';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, l, e) => { if (c) { pass++; console.log('OK   ' + l); } else { fail++; console.log('FAIL ' + l + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } };
const boot = () => spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HN_DATA_DIR: DIR }, stdio: 'ignore' });
const stop = (p) => new Promise((r) => { if (!p || p.exitCode !== null) return r(); p.once('exit', r); p.kill(); setTimeout(r, 3000); });
const up = async () => { for (let i = 0; i < 40; i++) { try { await fetch(B + '/api/health'); return true; } catch { await sleep(250); } } return false; };
const post = async (p, body, token) => {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(B + p, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
  return await r.json().catch(() => null);
};
let srv = boot();
await up();
const me = (await post('/api/auth/guest', {})).token;
const room = await post('/api/rooms', { name: '重启保留测试房' }, me);
const rid = room.roomId;
const tracks = [1, 2, 3, 4, 5].map((i) => ({ bvid: 'BV1KEEP00' + i, cid: 'k' + i, title: '保留' + i, cover: '', duration: 100 }));
await post('/api/rooms/' + rid + '/control', { action: 'queue-add-batch', tracks }, me);
// 切到第 3 首，播一会儿（做出"听到一半"的状态）
const st0 = (await (await fetch(B + '/api/rooms/' + rid, { headers: { Authorization: 'Bearer ' + me } })).json());
await post('/api/rooms/' + rid + '/control', { action: 'play-item', itemId: st0.queue.items[2].id }, me);
await post('/api/rooms/' + rid + '/control', { action: 'play', position: 0 }, me);
await sleep(1500);
const before = await (await fetch(B + '/api/rooms/' + rid, { headers: { Authorization: 'Bearer ' + me } })).json();
console.log('  重启前: 队列 ' + before.queue.items.length + ' 首，当前「' + before.track.title + '」，位置 ' + before.position.toFixed(1) + 's，isPlaying=' + before.isPlaying);

await stop(srv);
srv = boot();
await up();
console.log('  （重启完成）');
const after = await (await fetch(B + '/api/rooms/' + rid, { headers: { Authorization: 'Bearer ' + me } })).json();
ok(after && after.roomId === rid, '① 房间本身还在（没被清掉）', after && after.roomId);
ok(after.queue && after.queue.items.length === 5, '② 队列 5 首一首没丢', after.queue && after.queue.items.length);
ok(after.track && after.track.title === '保留3', '③ 当前曲目还是第 3 首', after.track && after.track.title);
ok(after.isPlaying === false, '④ 暂停状态（没人了，不该自己往下放）', after.isPlaying);
ok(after.position > 0.5 && after.position < 5, '⑤ 位置停在离开那一刻（不是归零）', after.position);
ok(after.queue.items.map((x) => x.title).join() === '保留1,保留2,保留3,保留4,保留5', '⑥ 顺序也没乱', after.queue.items.map((x) => x.title));

// ⑦ 等 8 秒（超过 5 秒的空房回收），房间还得在
await sleep(8000);
const later = await (await fetch(B + '/api/rooms/' + rid, { headers: { Authorization: 'Bearer ' + me } })).json();
ok(later && later.roomId === rid, '⑦ 过了 8 秒（空房回收是 5 秒）也没被回收', later && later.roomId);

// ⑧ 接管：另一个身份进去，房主应该变成他
const other = (await post('/api/auth/guest', {})).token;
const joined = await post('/api/rooms/' + rid + '/join', {}, other);
ok(joined && joined.you && joined.you.isHost === true, '⑧ 重启后第一个进来的人接管房主（原房主不回来房间也能用）', joined && joined.you);
await fetch(B + '/api/rooms/' + rid, { method: 'DELETE', headers: { Authorization: 'Bearer ' + other } });

await stop(srv);
fs.rmSync(DIR, { recursive: true, force: true });
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
