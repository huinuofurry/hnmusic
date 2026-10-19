// 给收藏夹条目抓 B站 标签（2026/10/19 用户要求：删掉 tag 里带 bms / arcaea 这类热门音游的曲子，
// 但**世界计划 / pjsk / プロセカ 不删** —— 那是联名 VOCALOID 的音游）。
//
// 为什么要在本机跑：一首一次请求（4700 首），在服务器上跑会把服务器 IP 打成 412，
// 连累播放和首页。本机是另一条出口，而且要**慢慢来**（默认 1 并发 / 200ms）。
//
//   node scripts/classify-fav-tags.mjs                 # 断点续抓（可重复跑）
//   node scripts/classify-fav-tags.mjs --limit=50      # 先试 50 个
//   node scripts/classify-fav-tags.mjs --print         # 只统计已有结果，不发请求
//
// 结果: backups/fav-tags.json  { at, tags: { bvid: { tags: [...], title } } }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRV = process.env.HN_SRV || 'http://124.220.169.253:8443';
const MID = process.env.HN_FAV_MID || '17800413';
const OUT = path.join(ROOT, 'backups', 'fav-tags.json');
const argv = process.argv.slice(2);
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const PRINT_ONLY = argv.includes('--print');
const GAP = Number((argv.find((a) => a.startsWith('--gap=')) || '').split('=')[1]) || 200;
// 只抓"可疑项"（2026/10/19 加的）：全量 4700 首会吃 412（150ms 间隔时第 234 个就中），
// 所以默认只抓"分区是游戏/标题带音游名/标题完全不像音乐"的那批。
const SUSPECTS_ONLY = argv.includes('--suspects');
// 走服务器出口（`--via-server`，需要 HN_TOKEN=管理员令牌）。本机 IP 被 412 后用它。
const VIA_SERVER = argv.includes('--via-server');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function load() {
    try {
        return JSON.parse(readFileSync(OUT, 'utf8'));
    } catch {
        return { at: 0, tags: {} };
    }
}
function save(db) {
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(db));
}
async function favItems() {
    const r = await fetch(SRV + '/api/bili/fav-folder?mid=' + MID + '&limit=5000');
    if (!r.ok) throw new Error('取收藏夹失败 HTTP ' + r.status);
    return (await r.json()).items || [];
}
async function tagsOf(bvid) {
    if (VIA_SERVER) {
        // 走服务器出口（本机 IP 被 412 之后的备用通道；服务器上那个口子只给管理员）
        const tok = process.env.HN_TOKEN || '';
        const r = await fetch(SRV + '/api/admin/fav-tags?bvid=' + encodeURIComponent(bvid), {
            headers: tok ? { Authorization: 'Bearer ' + tok } : {},
        });
        const t = await r.text();
        let d = null;
        try { d = JSON.parse(t); } catch { d = null; }
        if (!d) return { err: 'non-json' };
        if (r.ok && Array.isArray(d.tags)) return { tags: d.tags };
        return { err: 'HTTP ' + r.status + ' ' + String(d.error || '') };
    }
    const r = await fetch('https://api.bilibili.com/x/tag/archive/tags?bvid=' + encodeURIComponent(bvid), { headers: H });
    const t = await r.text();
    let d = null;
    try { d = JSON.parse(t); } catch { d = null; }
    if (!d) return { err: 'non-json' };
    if (d.code === 0) return { tags: (d.data || []).map((x) => String(x.tag_name || '')).filter(Boolean) };
    return { err: 'code=' + d.code + ' ' + String(d.message || '') };
}

function report() {
    // ⚠️ 判据只有一份：直接调 bili.js 的 favKeepItem（它读 HN_FAV_TIDS / HN_FAV_TAGS）。
    //    自己再写一份"标签判定"就会和线上跑偏（§六 第 22 条踩过）。
    process.env.HN_FAV_TIDS = path.join(ROOT, 'backups', 'fav-tids.json');
    process.env.HN_FAV_TAGS = OUT;
    return import('file:///' + path.join(ROOT, 'src', 'bili.js').replace(/\\/g, '/'));
}

async function main() {
    const items = await favItems();
    const db = load();
    const known = Object.keys(db.tags).length;
    console.log('收藏夹 ' + items.length + ' 条，已有标签 ' + known + ' 条');
    if (PRINT_ONLY) {
        const biliMod0 = await report();
        let drop = 0;
        for (const it of items) {
            const rec = db.tags[it.bvid];
            if (!rec) continue;
            if (!biliMod0.favKeepItem(it)) {
                drop++;
                console.log('  剔 ' + it.bvid + '  [' + rec.tags.slice(0, 6).join(' / ') + ']  ' + String(it.title).slice(0, 40));
            }
        }
        console.log('结论: 会剔 ' + drop + ' 条');
        return;
    }
    let todo = items.filter((it) => !db.tags[it.bvid]);
    if (SUSPECTS_ONLY) {
        // 只抓"有音游痕迹 / 看不出来是不是术"的条目：
        //   ① 分区是音游 / 游戏（136 音游、17 单机、172 手游…）
        //   ② 标题里有音游名（Arcaea / BMS / maimai / 太鼓…）
        //   ③ 标题既没有【…】、也不像音乐（这种最可能混着非术的东西）
        const bili0 = await import('file:///' + path.join(ROOT, 'src', 'bili.js').replace(/\\/g, '/'));
        let tids = {};
        try {
            tids = JSON.parse(readFileSync(path.join(ROOT, 'backups', 'fav-tids.json'), 'utf8')).tids || {};
        } catch { /* 没有就算了 */ }
        const GAME_TID = new Set([136, 17, 172, 4, 19, 20]);
        const GAME_NAME = /音游|arcaea|phigros|bms|chunithm|maimai|舞萌|太鼓|deemo|cytus|osu|muse ?dash|喵斯|bang ?dream|バンドリ|d4dj|プロセカ|世界计划|pjsk|project sekai|beatmania|iidx|sound voltex|sdvx|ongeki|オンゲキ|wacca|jubeat|popn|ポップン|groove coaster|ノスタルジア|音ゲー/i;
        todo = todo.filter((it) => {
            const rec = tids[it.bvid];
            if (rec && GAME_TID.has(rec.tid)) return true;
            if (GAME_NAME.test(String(it.title || ''))) return true;
            if (!bili0.looksLikeSong(it)) return true;
            return false;
        });
    }
    if (LIMIT) todo = todo.slice(0, LIMIT);
    console.log('待抓标签: ' + todo.length + '（间隔 ' + GAP + 'ms，约 ' + Math.ceil((todo.length * GAP) / 1000 / 60) + ' 分钟）' + (SUSPECTS_ONLY ? '，只抓可疑项' : ''));
    let done = 0;
    let aborted = false;
    const t0 = Date.now();
    for (const it of todo) {
        if (aborted) break;
        const r = await tagsOf(it.bvid);
        if (r.err) {
            db.tags[it.bvid] = { tags: [], title: it.title, err: r.err };
            if (/412|限流|non-json/.test(r.err)) {
                console.error('\n⚠️ B站 限流了（' + r.err + '）—— 停下，已抓的都在缓存里，过 10 分钟再跑');
                aborted = true;
            }
        } else {
            db.tags[it.bvid] = { tags: r.tags, title: it.title };
        }
        done++;
        if (done % 25 === 0) save(db);
        if (done % 200 === 0) {
            const sec = Math.round((Date.now() - t0) / 1000);
            console.log('  进度 ' + done + '/' + todo.length + '（' + sec + 's，剩约 ' + Math.round((sec / done) * (todo.length - done)) + 's）');
        }
        if (GAP) await sleep(GAP);
    }
    db.at = Date.now();
    save(db);
    console.log('完成 ' + done + ' 个' + (aborted ? '（被限流中断）' : ''));

    // 汇总（判据用 bili.js 的 favKeepItem，和线上完全一致）
    const biliMod = await report();
    let drop = 0;
    const dropList = [];
    for (const it of items) {
        const rec = db.tags[it.bvid];
        if (!rec) continue;
        if (!biliMod.favKeepItem(it)) {
            drop++;
            dropList.push('  ' + it.bvid + '  [' + rec.tags.slice(0, 6).join(' / ') + ']  ' + String(it.title).slice(0, 44));
        }
    }
    console.log('');
    console.log('已打标签 ' + Object.keys(db.tags).length + ' 条，其中会剔 ' + drop + ' 条：');
    for (const l of dropList.slice(0, 60)) console.log(l);
    console.log('');
    console.log('结果: ' + path.relative(ROOT, OUT));
}

main().catch((e) => {
    console.error('出错: ' + (e && e.stack || e));
    process.exit(1);
});
