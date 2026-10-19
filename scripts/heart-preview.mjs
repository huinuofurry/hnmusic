// 心动模式"预演"：把 public/index.html 的主脚本**真的跑起来**（假 DOM），
// 调它自己的 heartNextFrom 连挑 30 首 —— 不另写一份算法（另写一份必然跑偏）。
//
//   node scripts/heart-preview.mjs                 # 30 首
//   node scripts/heart-preview.mjs --count=15
//   node scripts/heart-preview.mjs --seed=BV1xxx   # 指定种子（默认按规则随机）
//
// 数据走**线上接口**（/api/bili/related · /api/bili/creators · /api/bili/fav-folder），
// 日志（[heart] 开头那些）写到 backups/heart-preview.log，方便出问题时回看。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRV = process.env.HN_SRV || 'http://124.220.169.253:8443';
const argv = process.argv.slice(2);
const COUNT = Number((argv.find((a) => a.startsWith('--count=')) || '').split('=')[1]) || 30;
const SEED = (argv.find((a) => a.startsWith('--seed=')) || '').split('=')[1] || '';

const html = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const js = blocks.sort((a, b) => b.length - a.length)[0];

// ---------- 假 DOM（够主脚本跑起来就行；和 check-frontend 一个套路） ----------
function stub(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        children: [],
        dataset: {},
        style: { setProperty() {}, getPropertyValue: () => '', removeProperty() {} },
        _attrs: {},
        _handlers: {},
        classList: {
            _s: new Set(),
            add(c) { this._s.add(String(c)); }, remove(c) { this._s.delete(String(c)); },
            toggle(c, on) { const v = on === undefined ? !this._s.has(String(c)) : !!on; if (v) this._s.add(String(c)); else this._s.delete(String(c)); return v; },
            contains(c) { return this._s.has(String(c)); },
        },
        hidden: false, value: '', textContent: '', className: '', title: '', type: '',
        placeholder: '', maxLength: 0, disabled: false, controls: true, volume: 1, muted: false,
        currentTime: 0, duration: 0, paused: true, readyState: 0, src: '',
        get firstElementChild() { return this.children[0] || null; },
        get lastElementChild() { return this.children[this.children.length - 1] || null; },
        appendChild(c) { this.children.push(c); return c; },
        append(...c) { this.children.push(...c); },
        prepend(...c) { this.children.unshift(...c); },
        replaceChildren(...c) { this.children.length = 0; this.children.push(...c); },
        insertBefore(c) { this.children.push(c); return c; },
        remove() {}, removeChild() {}, removeAttribute(k) { delete this._attrs[k]; },
        setAttribute(k, v) { this._attrs[k] = String(v); },
        getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
        hasAttribute(k) { return k in this._attrs; },
        addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
        removeEventListener() {},
        _fire(t, e) { for (const f of this._handlers[t] || []) f(e || {}); },
        contains() { return false; },
        animate() { return { onfinish: null, finished: Promise.resolve(), cancel() {} }; },
        scrollIntoView() {}, focus() {}, blur() {}, select() {}, load() {},
        play() { return Promise.resolve(); }, pause() {},
        getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    };
    let ih = '';
    Object.defineProperty(el, 'innerHTML', { get: () => ih, set(v) { ih = String(v); if (v === '') el.children.length = 0; } });
    return el;
}
const ids = new Map();
const doc = {
    getElementById: (id) => { if (!ids.has(id)) ids.set(id, stub('div')); return ids.get(id); },
    createElement: (t) => stub(t),
    createElementNS: (ns, t) => stub(t),
    addEventListener() {}, removeEventListener() {},
    querySelector: () => stub('div'),
    querySelectorAll: () => [],
    execCommand: () => true,
    body: stub('body'),
    documentElement: stub('html'),
    visibilityState: 'visible',
};
const mm = (q) => ({ matches: false, media: String(q || ''), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = mm;
globalThis.requestAnimationFrame = (fn) => { try { fn(0); } catch {} return 0; };
globalThis.cancelAnimationFrame = () => {};
const win = { addEventListener() {}, removeEventListener() {}, matchMedia: mm, innerWidth: 1280, innerHeight: 800, isSecureContext: true };

const store = { _m: {}, getItem(k) { return k in this._m ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };

// ---------- fetch：接口真实请求打到线上，其它给假数据 ----------
let token = '';
const logs = [];
const realFetch = globalThis.fetch;
async function fakeFetch(url, opt = {}) {
    const u = String(url);
    const json = async (o) => ({ ok: true, status: 200, json: async () => o });
    if (u.startsWith('/api/auth/guest')) {
        if (!token) {
            const r = await realFetch(SRV + '/api/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            token = (await r.json()).token || '';
        }
        return json({ token });
    }
    if (u.startsWith('/api/auth/me')) return json({ session: { sid: 's1' }, user: null });
    if (u.startsWith('/api/state')) return json({ playlists: [], shared: [], queue: { items: [], currentId: null, mode: 'sequence' } });
    if (u.startsWith('/api/rooms')) return json({ rooms: [] });
    if (u.startsWith('/api/bili/fav-preview')) return json({ items: [] });
    if (u.startsWith('/api/')) {
        const headers = { ...(opt.headers || {}) };
        if (token) headers.Authorization = 'Bearer ' + token;
        const r = await realFetch(SRV + u, { ...opt, headers });
        const data = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, json: async () => data };
    }
    return json({});
}

// 静音 + 抓日志（[heart] 那些要写进日志文件）
const origWarn = console.warn;
console.warn = (...a) => { const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); logs.push(line); };
const origLog = console.log;

const harness = js + `
;return {
  heartNextFrom, heartSeen, heartTitles, heartVoices, heartCreators,
  heartCreatorCache, heartInfoCache, relCache, farFavPool, pushVoiceHistory, trailingUnknownRun,
  voiceOf, titleSim, HEART_BAN,
};`;

let api = null;
try {
    api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
        doc, store, fakeFetch, { clipboard: undefined }, win, (fn, ms) => setTimeout(fn, ms)
    );
} catch (e) {
    console.error('主脚本跑不起来: ' + e.message);
    process.exit(1);
}
await new Promise((r) => setTimeout(r, 300)); // 让启动链的异步请求落地

// ---------- 种子：和 heartToggle 一样（收藏夹前 40 里、播放量<2万 的随机） ----------
const favRes = await (await fakeFetch('/api/bili/fav-folder?limit=40')).json();
const favItems = favRes.items || [];
let seed = null;
if (SEED) {
    seed = favItems.find((x) => x.bvid === SEED) || { bvid: SEED, title: '(指定种子)' };
} else {
    // 和 heartToggle 一致：种子本身不能带禁词（否则相关推荐整片同类，开局就没候选）
    const cleanSeed = favItems.filter((x) => !api.HEART_BAN.test(String(x.title || '')));
    const usable = cleanSeed.length ? cleanSeed : favItems;
    const small = usable.filter((x) => Number(x.view) > 0 && Number(x.view) < 20000);
    const pool = small.length ? small : usable;
    seed = pool[Math.floor(Math.random() * pool.length)] || null;
}
if (!seed) {
    console.error('取不到种子');
    process.exit(1);
}
api.heartSeen.add(seed.bvid);
// heartToggle 里还会把收藏夹前 20 首塞进排除表
const fav20 = await (await fakeFetch('/api/bili/fav-folder?limit=20')).json();
for (const it of fav20.items || []) api.heartTitles.push({ title: String(it.title || ''), duration: Number(it.duration) || 0 });

// ---------- 连挑 COUNT 首 ----------
const picked = [];
let cur = seed.bvid;
for (let i = 0; i < COUNT; i++) {
    const it = await api.heartNextFrom(cur);
    if (!it) {
        logs.push('[preview] 第 ' + (i + 1) + ' 首没挑到，停');
        break;
    }
    const voice = api.voiceOf(it.bvid) || '';
    const creator = api.heartCreatorCache.get(it.bvid) || '';
    picked.push({ ...it, _voice: voice, _creator: creator, _mixed: api.farFavPool.has(it.bvid) });
    // 按 heartPlay 的规则记账（这几行必须和 heartPlay 一致）
    api.heartSeen.add(it.bvid);
    api.heartTitles.push({ title: String(it.title || ''), duration: Number(it.duration) || 0, creator });
    if (api.heartTitles.length > 80) api.heartTitles.shift();
    api.pushVoiceHistory(it.bvid); // 和前端一样记账（歌姬 + 是否可信）
    if (creator) {
        api.heartCreators.push(creator);
        if (api.heartCreators.length > 30) api.heartCreators.shift();
    }
    cur = it.bvid;
}
console.warn = origWarn;

// ---------- 输出 ----------
console.log('种子：' + String(seed.title || '').slice(0, 50) + '（' + seed.bvid + '）');
console.log('');
console.log('| # | 标题 | 歌姬 | P主 | 播放量 | 备注 |');
console.log('|---|---|---|---|---|---|');
picked.forEach((it, i) => {
    const note = it._mixed ? '混入(权重1)' : '';
    console.log('| ' + (i + 1) + ' | ' + String(it.title || '').slice(0, 42) + ' | ' + (it._voice || '?') + ' | ' + String(it._creator || '?').split('|').join(' / ') + ' | ' + (it.view || 0) + ' | ' + note + ' |');
});

// ---------- 同质化诊断（用户真正想确认的：B站 是不是在推重复/雷同的东西） ----------
const byVoice = new Map();
for (const it of picked) byVoice.set(it._voice || '(未知)', (byVoice.get(it._voice || '(未知)') || 0) + 1);
const voiceTop = [...byVoice.entries()].sort((a, b) => b[1] - a[1]);
const knownVoice = voiceTop.filter(([v]) => v && v !== '(未知)');
const unknownN = picked.length - knownVoice.reduce((a, b) => a + b[1], 0);
const topVoice = knownVoice[0] || ['(无)', 0];
const byCreator = new Map();
for (const it of picked) byCreator.set(it._creator || '(未知)', (byCreator.get(it._creator || '(未知)') || 0) + 1);
const creatorTop = [...byCreator.entries()].sort((a, b) => b[1] - a[1]);

// 最长连跑（同歌姬 / 同 P主）
function longestRun(arr) {
    let best = 1;
    let cur = 1;
    for (let i = 1; i < arr.length; i++) {
        if (arr[i] && arr[i] === arr[i - 1]) cur++;
        else cur = 1;
        if (cur > best) best = cur;
    }
    return arr.length ? best : 0;
}
const runVoice = longestRun(picked.map((x) => x._voice || ''));
const runCreator = longestRun(picked.map((x) => x._creator || ''));

// 疑似"同一首歌"（标题相似 ≥0.62，去重判据没抓住的那些）
const dupPairs = [];
for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) {
        const sim = api.titleSim(picked[i].title, picked[j].title);
        if (sim >= 0.62) dupPairs.push({ a: i + 1, b: j + 1, sim: sim.toFixed(2), ta: picked[i].title, tb: picked[j].title });
    }
}

console.log('');
console.log('===== 同质化诊断 =====');
console.log('歌姬分布：' + voiceTop.map(([v, n]) => v + '×' + n).join('  '));
console.log('  · 能识别出歌姬的 ' + (picked.length - unknownN) + ' 首；最多的歌姬：' + topVoice[0] + '（' + topVoice[1] + ' 首）');
console.log('  · 最长连续同歌姬：' + runVoice + ' 首');
console.log('P主分布（前 5）：' + creatorTop.slice(0, 5).map(([v, n]) => v + '×' + n).join('  '));
console.log('  · 最长连续同 P主：' + runCreator + ' 首');
console.log('疑似同一首被推了两次：' + (dupPairs.length ? dupPairs.length + ' 对' : '0 对'));
for (const d of dupPairs.slice(0, 6)) console.log('  ⚠ #' + d.a + ' vs #' + d.b + '（相似 ' + d.sim + '）  ' + String(d.ta).slice(0, 26) + '  |  ' + String(d.tb).slice(0, 26));
const dampLines = logs.filter((l) => l.includes('权重 ×0.4'));
const mixLines = logs.filter((l) => l.includes('混入'));
console.log('规则触发：降权 ' + dampLines.length + ' 次 / 混入收藏夹 5 首 ' + mixLines.length + ' 次');
const heavy = (knownVoice.length ? topVoice[1] / Math.max(1, picked.length - unknownN) >= 0.4 : false) || runVoice >= 4 || runCreator >= 4 || dupPairs.length >= 3;
console.log('结论：' + (heavy ? '同质化**严重**（B站 在推同一个歌姬/同一个 UP 的货）' : '同质化还可以（没有明显的单一来源霸屏）'));

// ---------- 顺手写一份 markdown 报告 ----------
{
    const md = [];
    md.push('# 心动模式预演（' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '）');
    md.push('');
    md.push('- 种子：' + String(seed.title || '').slice(0, 60) + '（' + seed.bvid + '）');
    md.push('- 挑出：' + picked.length + ' 首');
    md.push('- 歌姬分布：' + voiceTop.map(([v, n]) => v + '×' + n).join(' / '));
    md.push('- 最长连续同歌姬：' + runVoice + ' 首；最长连续同 P主：' + runCreator + ' 首');
    md.push('- 疑似同一首被推两次：' + dupPairs.length + ' 对');
    md.push('- 规则触发：降权 ' + dampLines.length + ' 次 / 混入收藏夹 5 首 ' + mixLines.length + ' 次');
    md.push('- **结论：' + (heavy ? '同质化严重' : '同质化还可以') + '**');
    md.push('');
    md.push('| # | 标题 | 歌姬 | P主 | 播放量 |');
    md.push('|---|---|---|---|---|');
    picked.forEach((it, i) =>
        md.push('| ' + (i + 1) + ' | ' + String(it.title || '').replace(/\|/g, '\\|').slice(0, 62) + ' | ' + (it._voice || '?') + ' | ' + String(it._creator || '?').split('|').join(' / ') + ' | ' + (it.view || 0) + ' |')
    );
    if (dupPairs.length) {
        md.push('');
        md.push('## 疑似重复（标题相似 ≥0.62）');
        for (const d of dupPairs) md.push('- #' + d.a + ' vs #' + d.b + '（' + d.sim + '）：' + String(d.ta).slice(0, 40) + '  |  ' + String(d.tb).slice(0, 40));
    }
    writeFileSync(path.join(ROOT, 'backups', 'heart-preview.md'), md.join('\n'));
}

// ---------- 日志 ----------
mkdirSync(path.join(ROOT, 'backups'), { recursive: true });
const logPath = path.join(ROOT, 'backups', 'heart-preview.log');
const head = [
    '===== 心动模式预演 ' + new Date().toISOString() + ' =====',
    '种子: ' + seed.bvid + ' ' + seed.title,
    '挑出: ' + picked.length + ' 首',
    '歌姬分布: ' + voiceTop.map(([v, n]) => v + '×' + n).join(' / '),
    '最长连续同歌姬: ' + runVoice + ' / 同P主: ' + runCreator + ' / 疑似同曲: ' + dupPairs.length + ' 对',
    '',
];
writeFileSync(logPath, head.concat(logs).join('\n'));
console.log('');
console.log('日志已写: ' + path.relative(ROOT, logPath) + '（' + logs.length + ' 行）');
