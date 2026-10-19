// 离线检查条目校验（src/track.js）—— 不联网、不碰数据。
//
// 为什么必须有这个文件：2026/10/15 出过一次很隐蔽的事故 ——
// api.js 和 rooms.js 各有一份 requireTrack，我只放宽了 rooms.js 那份，
// 于是 **房间队列能加、自己的队列加不了**：
//     POST /api/queue/items 带空 cid → 400 缺少 cid
// 而导入的歌单条目**就是没有 cid**（播到那首才补），所以现象是
//     "播过的歌（cid 回写进去了）能播，没播过的点播放没反应"
// 用户朋友的原话是"双击和点旁边的播放都有概率没用"。
//
// 现在两份合并成一份（src/track.js），这个脚本盯住它的行为别再退化。
//
// 用法：node scripts/check-track.mjs
import { requireTrack } from '../src/track.js';

let pass = 0;
let bad = 0; // ⚠️ 计数器别叫 fail —— 这个文件里 fail 是"报错"函数（我第一版重名了，
//             结果那条断言一跑就 TypeError，等于根本没在检查）
function ok(cond, label, extra) {
    if (cond) {
        pass++;
        console.log('OK   ' + label);
    } else {
        bad++;
        console.log('FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
    }
}
function fail(message) {
    bad++;
    console.log('FAIL ' + message);
}

console.log('--- 必须通过（导入的歌单条目就是这样：有 bvid、没 cid）---');
try {
    const r = requireTrack({ bvid: 'BV1Aupg64ECJ', cid: '', title: '白蓮', author: 'nanka', cover: 'c', duration: 251 });
    ok(r.cid === '', '空 cid 能通过，且 cid 归一成空串');
    ok(r.bvid === 'BV1Aupg64ECJ' && r.title === '白蓮' && r.author === 'nanka' && r.duration === 251, '字段都保留', r);
} catch (e) {
    fail('空 cid 被拒了 —— 导入的歌单会点不动：' + e.message);
}
try {
    const r = requireTrack({ bvid: 'BV1x', cid: '123' });
    ok(r.cid === '123', '正常带 cid 的条目通过');
    ok(r.title === '' && r.author === '' && r.cover === '' && r.duration === 0, '缺省字段补成空/0', r);
} catch (e) {
    fail('正常条目被拒了: ' + e.message);
}
try {
    const r = requireTrack({ bvid: 123, cid: 456 });
    ok(r.bvid === '123' && r.cid === '456', '数字类型的 bvid/cid 也能归一成字符串', r);
} catch (e) {
    fail('数字类型被拒了: ' + e.message);
}

console.log('');
console.log('--- 必须拒绝 ---');
for (const [input, label] of [
    [{ bvid: '', cid: '1' }, '空 bvid'],
    [{ cid: '1' }, '缺 bvid'],
    [{ bvid: null }, 'bvid 是 null'],
    [null, 'null'],
    [undefined, 'undefined'],
    ['BV1', '传了字符串而不是对象'],
]) {
    let rejected = false;
    let status = 0;
    try {
        requireTrack(input);
    } catch (e) {
        rejected = true;
        status = e.status;
    }
    ok(rejected && status === 400, label + ' → 400', status);
}

console.log('');
console.log('--- 关键：只允许有**一份** requireTrack ---');
{
    const fs = await import('node:fs');
    const files = ['src/api.js', 'src/rooms.js'];
    for (const f of files) {
        const t = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
        // 出现函数定义就说明又抄了一份 —— 两份必然会跑偏
        if (/function requireTrack\s*\(/.test(t)) fail(f + ' 里又定义了一份 requireTrack（应该 import src/track.js）');
    }
    ok(true, 'api.js / rooms.js 都没有自己那份 requireTrack');
}

console.log('');
console.log('--- 上限常量也只能有一份 ---');
{
    const fs = await import('node:fs');
    const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const track = read('src/track.js');
    const mPl = track.match(/export const PLAYLIST_MAX = (\d+)/);
    const mBatch = track.match(/export const BATCH_MAX = (\w+)/);
    ok(!!mPl, 'track.js 里定义了 PLAYLIST_MAX', mPl && mPl[1]);
    ok(!!mBatch, 'track.js 里定义了 BATCH_MAX', mBatch && mBatch[1]);
    // ⚠️ 真事故：批量上限原来是随手写的 200，比歌单上限 1000 还小 ——
    //    于是房间里点【播放全部】（991 首）直接被挡："一次最多加 200 首"。
    //    批量上限**至少要能一次加完一个满歌单**。
    if (mBatch && mBatch[1] !== 'PLAYLIST_MAX') {
        fail('BATCH_MAX 应该直接等于 PLAYLIST_MAX（别再拍一个更小的数）');
    }
    for (const f of ['src/api.js', 'src/index.js', 'src/rooms.js']) {
        const t = read(f);
        if (/(?:const|let|var)\s+PLAYLIST_MAX\s*=/.test(t) || /(?:const|let|var)\s+BATCH_MAX\s*=/.test(t)) {
            fail(f + ' 又自己定义了一份上限常量（应该 import src/track.js）');
        }
    }
    ok(true, 'api.js / index.js / rooms.js 都用 track.js 里那一份上限');
}

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + bad + ' 项');
if (bad) {
    console.log('');
    console.log('⚠️  改条目校验/上限时记住：**只改 src/track.js 这一份**。');
    console.log('    cid 必须允许为空 —— 导入的歌单条目播到那首才补 cid。');
}
process.exit(bad ? 1 : 0);
