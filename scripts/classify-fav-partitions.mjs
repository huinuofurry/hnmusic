// 给默认收藏夹的每一首打上"分区"（tid），用来剔掉非音乐的。
// 2026/10/19 用户要求：「顺便再清理一下非音乐分区的，默认收藏夹里稍微有些不是」。
//
// 为什么要在**本机**跑、而不是在服务器上跑：
//   · 每首要问一次 B站 `view`，4800 首就是 4800 次请求；上一轮我在服务器上那么干，
//     直接把**服务器 IP** 打成 412，连播放和首页都被连累 ✗
//   · 本机是另一个出口 IP，打慢了（1 并发 / 300ms）对线上零影响 ✓
//   · 断点续查：结果写 backups/fav-tids.json，中断/412 之后重跑只问没问过的 ✓
//
// 用法：
//   node scripts/classify-fav-partitions.mjs                 # 打标签（可断点续跑）
//   node scripts/classify-fav-partitions.mjs --limit=50      # 只做前 50 个（试跑）
//   node scripts/classify-fav-partitions.mjs --print         # 只统计已有的结果，不请求
//
// 输出：
//   backups/fav-tids.json        { 生成时间, 统计, tids: { bvid: {tid, tname, title} } }
//   backups/fav-tids.txt         人类可读的"每个 tid 有多少首、样例"清单
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRV = process.env.HN_SRV || 'http://124.220.169.253:8443';
const MID = process.env.HN_FAV_MID || '17800413';
const OUT = path.join(ROOT, 'backups', 'fav-tids.json');
const TXT = path.join(ROOT, 'backups', 'fav-tids.txt');
const argv = process.argv.slice(2);
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const PRINT_ONLY = argv.includes('--print');
// 只给"结果会改变去留"的条目打标签（2026/10/19 加的）：
// 服务端规则是"没标签 ⇒ 保留"，所以只有**既不像音乐、又没标签**的条目才需要问 B站。
// 这样请求数从 4800 降到几百，不会再把 IP 打成 412。
const SUSPECTS_ONLY = argv.includes('--suspects');
const CONC = Number((argv.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || 1;
const GAP = Number((argv.find((a) => a.startsWith('--gap=')) || '').split('=')[1]) || 300;
// 走服务器去问（`--via-server`）：本机 IP 被 412 之后改走服务器那条出口。
// ⚠️ 只在**条目很少**时用（几十个）：量大了会把服务器 IP 也打成 412，连累播放。
const VIA_SERVER = argv.includes('--via-server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() {
    try {
        return JSON.parse(readFileSync(OUT, 'utf8'));
    } catch {
        return { at: 0, tids: {} };
    }
}
function save(db) {
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(db));
}

// ① 从**服务器缓存**拿全部 bvid（不碰 B站）
async function favItems() {
    const r = await fetch(SRV + '/api/bili/fav-folder?mid=' + MID + '&limit=5000');
    if (!r.ok) throw new Error('取收藏夹失败 HTTP ' + r.status);
    const j = await r.json();
    return j.items || [];
}

function report(db, items) {
    const byTid = new Map();
    for (const it of items) {
        const rec = db.tids[it.bvid];
        const tid = rec ? rec.tid : 'unknown';
        if (!byTid.has(tid)) byTid.set(tid, []);
        byTid.get(tid).push(it);
    }
    const lines = [];
    const rows = [...byTid.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [tid, arr] of rows) {
        const sample = arr[0] || {};
        lines.push('tid=' + String(tid).padEnd(8) + ' ' + String(arr.length).padStart(5) + ' 首   样例: ' + (sample.title || '').slice(0, 48));
    }
    return { lines, rows, unknown: (byTid.get('unknown') || []).length };
}

async function main() {
    const items = await favItems();
    console.log('服务器缓存里的收藏夹条目: ' + items.length + '（mid=' + MID + '）');
    const db = load();
    const known = Object.keys(db.tids).length;
    console.log('已有分区结果: ' + known);
    if (PRINT_ONLY) {
        const { lines, unknown } = report(db, items);
        console.log(lines.join('\n'));
        console.log('');
        console.log('还没打标签的: ' + unknown);
        writeFileSync(TXT, lines.join('\n') + '\n');
        console.log('清单已写到 ' + path.relative(ROOT, TXT));
        return;
    }

    let todo = items.filter((it) => !db.tids[it.bvid]);
    if (SUSPECTS_ONLY) {
        const bili0 = await import('file:///' + path.join(ROOT, 'src', 'bili.js').replace(/\\/g, '/'));
        // 只问"没标签 + 完全不像歌"的：像歌的（标题带【】/feat/MV、含歌姬名、含音乐词）
        // 服务端本来就会保留，没必要花请求
        todo = todo.filter((it) => !bili0.looksLikeSong(it));
    }
    if (LIMIT) todo = todo.slice(0, LIMIT);
    console.log('待打标签: ' + todo.length + '（并发 ' + CONC + ' / 间隔 ' + GAP + 'ms）' + (SUSPECTS_ONLY ? '，只查"可疑非音乐"' : ''));
    if (!todo.length) {
        const { lines } = report(db, items);
        console.log(lines.join('\n'));
        return;
    }

    const bili = await import('file:///' + path.join(ROOT, 'src', 'bili.js').replace(/\\/g, '/'));
    let done = 0;
    let failed = 0;
    const t0 = Date.now();
    let aborted = false;

    async function worker() {
        for (;;) {
            if (aborted) return;
            const it = todo.shift();
            if (!it) return;
            try {
                const r = VIA_SERVER
                    ? await (async () => {
                          const resp = await fetch(SRV + '/api/resolve?bvid=' + encodeURIComponent(it.bvid));
                          const data = await resp.json();
                          if (!resp.ok || !data || !data.bvid) {
                              const code = data && (data.biliCode || data.error);
                              throw new Error(code === 'non-json' ? '412' : String((data && data.error) || 'HTTP ' + resp.status));
                          }
                          return data;
                      })()
                    : await bili.resolve(it.bvid);
                db.tids[it.bvid] = { tid: r.tid, tname: r.tname, title: r.title };
            } catch (e) {
                const msg = String(e && e.message || e);
                if (/412|限流/.test(msg)) {
                    console.error('\n⚠️ B站 限流了（412）—— 停下来，已完成的都在缓存里，10 分钟后再跑');
                    aborted = true;
                    return;
                }
                failed++;
                // 失效视频：记一笔 dead，别反复问它
                if (/62002|不可见|不存在|-404/.test(msg)) {
                    db.tids[it.bvid] = { tid: 'dead', tname: '', title: it.title };
                } else {
                    db.tids[it.bvid] = { tid: 'unknown', tname: '', title: it.title, err: msg.slice(0, 80) };
                }
            }
            done++;
            if (done % 25 === 0) save(db);
            if (done % 100 === 0) {
                const sec = Math.round((Date.now() - t0) / 1000);
                console.log('  进度 ' + done + '/' + todo.length + '（' + sec + 's，剩约 ' + Math.round((sec / done) * todo.length - sec) + 's）');
            }
            if (GAP) await sleep(GAP);
        }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    db.at = Date.now();
    save(db);
    console.log('完成 ' + done + ' 个，失败/失效记录 ' + failed + ' 个' + (aborted ? '（被 412 中断）' : ''));

    const { lines, unknown } = report(db, items);
    writeFileSync(TXT, lines.join('\n') + '\n');
    console.log('');
    console.log(lines.join('\n'));
    console.log('');
    console.log('还没打标签的: ' + unknown);
    console.log('结果: ' + path.relative(ROOT, OUT));
}

main().catch((e) => {
    console.error('出错: ' + (e && e.stack || e));
    process.exit(1);
});
