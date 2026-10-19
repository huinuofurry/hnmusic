// 清理旧歌单里**已失效**的视频条目（2026/10/19 用户要求）。
//
// 为什么要单独做一次：`looksDead()` 只在**取列表**时过滤（搜索/收藏夹/相关推荐），
// 所以以前导入进歌单的失效条目一直躺在库里（点了播不出来）。
// 要清就得逐个问 B站 —— 这次线上是 1149 条、约一千次 `view` 请求，几分钟。
//
// 用法（默认是**演习**，什么都不删）：
//   node scripts/clean-dead-items.mjs                 # 只统计，打印"计划删除 N 条"
//   node scripts/clean-dead-items.mjs --limit=30      # 只查前 30 个 bvid（先小规模试）
//   node scripts/clean-dead-items.mjs --apply         # 真删（走 HTTP 接口，不碰 db.json）
//
// 判据（实测校准过）：
//   正常  → GET /api/resolve?bvid=… 返回 200 + {bvid,cid,title,…}
//   失效  → 500 + {biliCode:62002, error:"B站接口 62002: 稿件不可见"}
//           （还认 62004 审核中 / 62012 仅自己可见 / -404 / -403）
//   不确定 → 网络错、412 风控、429、超时……**一律保留，不删**
//
// ⚠️ 三条纪律：
//   1. **不确定 = 保留**。删错了没法恢复（B站 那边已经没了的视频，谁也找不回来）
//   2. **"计划删多少"和"实际删多少"必须打在相邻两行并当场比对**（§八.5 第 61 条的教训：
//      上一回两个数字差 5 倍我没比对，把 116 个游客会话全登出了）
//   3. 删除走 **HTTP 接口**（DELETE /api/playlists/:id/items/:id），不是改 db.json ——
//      服务在内存里持有一份副本，直接改文件会被它下次 save() 覆盖（§8.5）
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRV = process.env.HN_SRV || 'http://124.220.169.253:8443';
const USER = process.env.HN_ADMIN_USER || 'huinuo';
const PASS = process.env.HN_ADMIN_PASS || '258015124';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
// ⚠️ 默认**慢**：2026/10/19 我用 concurrency=3、gap=150ms 跑全量，把 B站 的 IP 打成
//    412（`view` 接口一千次左右就限流，窗口 >10 分钟）。现在默认 1 并发 + 350ms 间隔，
//    1149 个约 7~8 分钟 —— 宁可慢，也不要再被关在门外。
const CONC = Number((argv.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || 1;
const GAP_MS = Number((argv.find((a) => a.startsWith('--gap=')) || '').split('=')[1]) || 350;
const CACHE_FILE = path.join(HERE, '..', 'backups', 'dead-check-cache.json');

const DEAD_CODES = new Set([62002, 62004, 62012, -403, -404]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = '';

// 检查结果的本地缓存（bvid → 判定）。断点续查用：
// 412 中断之后重跑，已经确认过的不再问 B站，省请求也省时间。
function loadCache() {
    try {
        return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    } catch {
        return {};
    }
}
function saveCache(cache) {
    try {
        mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch { /* 写不了就算了，不影响清理 */ }
}

class RateLimited extends Error {
    constructor() {
        super('B站限流（412）');
        this.rateLimited = true;
    }
}

async function call(pathStr, opt = {}) {
    const headers = { ...(opt.headers || {}) };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opt.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(SRV + pathStr, { ...opt, headers, body: opt.body ? JSON.stringify(opt.body) : undefined });
    let data = null;
    try {
        data = await r.json();
    } catch {
        data = null;
    }
    return { status: r.status, data };
}

// 并发上限 + 每次请求之间留一点间隔（被 B站 风控就白跑了）
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    async function worker() {
        for (;;) {
            const idx = i++;
            if (idx >= items.length) return;
            out[idx] = await fn(items[idx], idx);
            if (GAP_MS) await sleep(GAP_MS);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

// 单个 bvid 的判定：'alive' | 'dead' | 'unknown'
// ⚠️ 遇 412 **立刻抛 RateLimited**，让整轮停下来 —— 继续重试只会把窗口拖得更长
async function classify(bvid) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const r = await call('/api/resolve?bvid=' + encodeURIComponent(bvid));
            if (r.status === 200 && r.data && r.data.bvid) return { state: 'alive' };
            const code = r.data && r.data.biliCode;
            if (DEAD_CODES.has(code)) return { state: 'dead', code, why: (r.data && r.data.error) || '' };
            const errText = String((r.data && r.data.error) || '');
            if (r.status === 412 || code === 'non-json' || /412|限流/.test(errText)) throw new RateLimited();
            if (r.status === 429 || r.status >= 500) {
                await sleep(1500 * (attempt + 1));
                continue;
            }
            return { state: 'unknown', why: 'HTTP ' + r.status + ' ' + errText };
        } catch (e) {
            if (e && e.rateLimited) throw e;
            if (attempt === 1) return { state: 'unknown', why: 'network: ' + e.message };
            await sleep(1500);
        }
    }
    return { state: 'unknown', why: 'retry exhausted' };
}

async function main() {
    console.log('服务器: ' + SRV);
    console.log('模式: ' + (APPLY ? '**真删**（--apply）' : '演习（只统计，不删）'));
    console.log('');

    const login = await call('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
    if (!login.data || !login.data.token) {
        console.error('登录失败: ' + JSON.stringify(login.data));
        process.exit(1);
    }
    token = login.data.token;
    if (!login.data.user || login.data.user.role !== 'admin') {
        console.error('不是管理员，拒绝继续');
        process.exit(1);
    }

    // ① 取我自己的歌单（/api/state 只给摘要，条目要逐个 /api/playlists/:id）
    const state = await call('/api/state');
    const pls = (state.data && state.data.playlists) || [];
    const detailed = [];
    let itemTotal = 0;
    for (const p of pls) {
        const d = await call('/api/playlists/' + encodeURIComponent(p.id));
        if (d.status !== 200 || !d.data) {
            console.log('  ⚠️ 读不到歌单 ' + p.id + '（' + d.status + '），跳过');
            continue;
        }
        const items = d.data.items || [];
        detailed.push({ id: p.id, name: d.data.name || p.name, items });
        itemTotal += items.length;
        console.log('歌单 ' + p.id + ' 「' + (d.data.name || p.name) + '」 ' + items.length + ' 条');
    }
    console.log('条目合计: ' + itemTotal + ' 条（服务端 /api/state 报的摘要仅供参考）');

    // ② 唯一 bvid（同一首可能同时出现在两个歌单里 ⇒ 只问一次 B站）
    const byBvid = new Map(); // bvid -> { items: [{plId, itemId, title}] }
    let noBvid = 0;
    for (const pl of detailed) {
        for (const it of pl.items) {
            const bv = String(it.bvid || '');
            if (!bv) {
                noBvid++;
                continue;
            }
            if (!byBvid.has(bv)) byBvid.set(bv, []);
            byBvid.get(bv).push({ plId: pl.id, itemId: it.id, title: it.title || '' });
        }
    }
    let bvids = [...byBvid.keys()];
    console.log('唯一 bvid: ' + bvids.length + ' 个（空 bvid ' + noBvid + ' 条）');
    if (LIMIT) {
        bvids = bvids.slice(0, LIMIT);
        console.log('⚠️ --limit=' + LIMIT + ' ⇒ 只查前 ' + bvids.length + ' 个');
    }
    console.log('');

    // ③ 逐个问 B站（走本服务的 /api/resolve，内部就是 view + looksDead 那套）
    //    带断点续查：先看本地缓存，只问没问过的
    const cache = loadCache();
    const todo = bvids.filter((bv) => !cache[bv]);
    console.log('本地缓存里已有: ' + (bvids.length - todo.length) + ' 个（只问剩下的 ' + todo.length + ' 个）');
    console.log('节奏: 并发 ' + CONC + ' / 间隔 ' + GAP_MS + 'ms（约 ' + Math.ceil((todo.length * (GAP_MS + 120)) / CONC / 1000) + ' 秒）');
    console.log('');
    const started = Date.now();
    let done = 0;
    let rateLimited = false;
    try {
        await mapLimit(todo, CONC, async (bv) => {
            const v = await classify(bv);
            cache[bv] = v;
            done++;
            if (done % 25 === 0) saveCache(cache);
            if (done % 50 === 0 || done === todo.length) {
                const sec = Math.max(1, Math.round((Date.now() - started) / 1000));
                const eta = Math.round((sec / done) * (todo.length - done));
                console.log('  进度 ' + done + '/' + todo.length + '（' + sec + 's，剩约 ' + eta + 's）');
            }
        });
    } catch (e) {
        if (!(e && e.rateLimited)) throw e;
        rateLimited = true;
    }
    saveCache(cache);
    if (rateLimited) {
        console.log('');
        console.log('⚠️ B站 限流了（412）—— 这一轮**主动停下**，没有再重试（重试只会把窗口拖长）。');
        console.log('   已确认 ' + done + ' 个，结果存在 ' + path.relative(path.join(HERE, '..'), CACHE_FILE) + '；');
        console.log('   等 10 分钟以上再跑一次同一条命令，会自动从断点继续。');
        process.exit(2);
    }

    // ④ 汇总
    const dead = [];
    const unknown = [];
    let alive = 0;
    for (const bv of bvids) {
        const v = cache[bv] || { state: 'unknown', why: 'no verdict' };
        if (v.state === 'alive') alive++;
        else if (v.state === 'dead') for (const rec of byBvid.get(bv)) dead.push({ bvid: bv, ...rec, code: v.code, why: v.why });
        else unknown.push({ bvid: bv, why: v.why });
    }
    const deadBvids = new Set(dead.map((d) => d.bvid));
    console.log('');
    console.log('检查结果（唯一 bvid）: 正常 ' + alive + ' / 失效 ' + deadBvids.size + ' / 不确定 ' + unknown.length);
    console.log('失效条目（按歌单条目算）: ' + dead.length + ' 条');
    console.log('');
    if (dead.length) {
        console.log('失效样例（前 10 条）:');
        for (const d of dead.slice(0, 10)) console.log('  · ' + d.plId + '  ' + d.bvid + '  ' + d.title);
    }
    if (unknown.length) {
        console.log('');
        console.log('⚠️ 不确定的 ' + unknown.length + ' 个（**保留不删**）:');
        for (const u of unknown.slice(0, 10)) console.log('  · ' + u.bvid + '  ' + u.why);
    }
    if (LIMIT) {
        console.log('');
        console.log('⚠️ 这次带了 --limit，检查不完整 —— 不带 limit 才算全量统计');
        return;
    }

    // ⑤ 演习：只报告；真删：逐条 DELETE
    if (!APPLY) {
        console.log('');
        console.log('计划删除: ' + dead.length + ' 条');
        console.log('（演习模式，什么都没删。确认数字后加 --apply 再跑一次）');
        return;
    }
    console.log('');
    console.log('计划删除: ' + dead.length + ' 条');
    let ok = 0;
    let failed = 0;
    const failures = [];
    for (const d of dead) {
        const r = await call('/api/playlists/' + encodeURIComponent(d.plId) + '/items/' + encodeURIComponent(d.itemId), { method: 'DELETE' });
        if (r.status === 200) ok++;
        else {
            failed++;
            failures.push({ ...d, status: r.status, error: r.data && r.data.error });
        }
        if (GAP_MS) await sleep(Math.max(30, Math.floor(GAP_MS / 3)));
    }
    console.log('实际删除: ' + ok + ' 条（失败 ' + failed + '）');
    console.log(ok === dead.length ? '✓ 计划与实际一致' : '✗ 计划与实际不一致，请检查下面的失败清单');
    if (failures.length) for (const f of failures.slice(0, 10)) console.log('  · ' + f.bvid + '  ' + f.status + '  ' + (f.error || ''));

    // ⑥ 删完复核：条目数应该正好少了 ok 条
    console.log('');
    console.log('复核（每条歌单的条目数）:');
    for (const pl of detailed) {
        const d = await call('/api/playlists/' + encodeURIComponent(pl.id));
        const after = d.status === 200 && d.data ? (d.data.items || []).length : -1;
        const removed = dead.filter((x) => x.plId === pl.id).length;
        console.log('  ' + pl.id + ' 「' + pl.name + '」 ' + pl.items.length + ' → ' + after + '（应减 ' + removed + '）' + (after === pl.items.length - removed ? ' ✓' : ' ✗'));
    }

    // ⑦ 留一份报告（含失效清单），放在 backups/ 里方便事后核对
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(HERE, '..', 'backups');
    mkdirSync(dir, { recursive: true });
    const report = path.join(dir, 'clean-dead-' + stamp + '.json');
    writeFileSync(report, JSON.stringify({
        at: new Date().toISOString(),
        server: SRV,
        itemTotal,
        uniqueBvid: bvids.length,
        alive,
        dead: dead.length,
        deleted: ok,
        failed,
        unknown,
        deadItems: dead,
    }, null, 2));
    console.log('');
    console.log('报告已写入: ' + report);
}

main().catch((e) => {
    console.error('出错: ' + (e && e.stack || e));
    process.exit(1);
});
