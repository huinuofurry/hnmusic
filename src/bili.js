// B 站适配层：整个项目只有这个文件知道 B 站存在。
// 将来 B 站改接口，只改这一个文件。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';
// 代理允许的目标域名（白名单，防 SSRF）。
// ⚠️ 2026/10/15 真事故：B 站会**按歌**把音频放在不同 CDN 上，那天起开始用
//    `*.edge.mountaintoys.cn`，而白名单里只有 bilivideo.com / hdslb.com ——
//    于是**只有一部分歌**放不出来，浏览器报 "The element has no supported sources"，
//    看着像"点了没反应、而且有概率"。前端那个"重新取流"也救不了：
//    重取回来的地址还是同一个被拒的域名。
// 所以：① 静态表补全常见 CDN ② **凡是 B 站 API 亲手给的取流地址，
//    它的域名自动登记**（见 trustHost）。这样既不指望我们预知所有 CDN，
//    也没有放宽成"任意域名" —— SSRF 防线还在（攻击者没法让 B 站 API
//    吐一个内网地址给我们）。
export const PROXY_ALLOW = [
    /\.bilivideo\.com$/,
    /\.bilivideo\.cn$/,
    /\.hdslb\.com$/,
    /\.biliimg\.com$/, // B 站图片 CDN（有些封面走这个）
    /\.akamaized\.net$/,
    /\.mountaintoys\.cn$/, // B 站的白牌 CDN（音频），2026/10/15 遇到
];
// 动态登记的可信域名（只由 trustHost 写入，来源都是 B 站 API 的返回）
const trustedHosts = new Set();
export function trustHost(u) {
    try {
        const h = new URL(u).hostname;
        if (h) trustedHosts.add(h);
    } catch {
        /* 不是合法 URL 就不登记 */
    }
}
export function isProxyAllowed(hostname) {
    return PROXY_ALLOW.some((re) => re.test(hostname)) || trustedHosts.has(hostname);
}
// ---------- 匿名指纹：拿一次，长期复用 ----------
let fp = null;
async function fingerprint() {
    if (fp) return fp;
    const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'User-Agent': UA, Referer: REFERER },
    }).then((x) => x.json());
    if (r.code !== 0) throw new Error('匿名指纹失败: ' + JSON.stringify(r));
    fp = { buvid3: r.data.b_3, buvid4: r.data.b_4, b_nut: Math.floor(Date.now() / 1000) };
    return fp;
}
// ---------- 可选的"小号"cookie（2026/10/17）----------
// 用户注册了一个**专用小号**：想让相关推荐走 B站 的"为你推荐"流 ——
// 他自己的原话："b站会根据我的偏好推送我没听过的冷门曲，平时我都是这样找的"。
//
// ⚠️ 只从**环境变量**读（HN_BILI_COOKIE）：不进数据库、不进备份、绝不下发浏览器 ✓
// ⚠️ 没设就完全走匿名（降级安全 ✓ 所有测试都跑这条路 ✓）
// ⚠️ 只用于**只读**接口（view/related/search/playurl/推荐流），绝不点赞收藏关注 ✗
// cookie 存哪儿？
//   · 环境变量 HN_BILI_COOKIE（手动设置 / scripts\set-bili-cookie.ps1 用）✓ 优先级最高
//   · 不然就读 data/.bili-cookie —— 扫码登录成功后**服务自己**写在这里 ✓
// ⚠️ 为什么不用 /etc/hnmusic.env：那个文件在 ProtectSystem=full 下要靠
//    ReadWritePaths 单独放开，实测服务写它时报 EACCES ✗（沙箱里同样的配置又能写，
//    与其跟它较劲，不如写到 data/ —— 那里本来就是 ReadWritePaths，权限稳 ✓）
const DATA_DIR = process.env.HN_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const COOKIE_FILE = path.join(DATA_DIR, '.bili-cookie');

function readCookieFile() {
    try {
        return String(fs.readFileSync(COOKIE_FILE, 'utf8')).trim();
    } catch {
        return '';
    }
}

// ⚠️ 可变的：管理员在「个人中心」扫码登录小号之后，这里会被**当场替换** ✓
//    （不用重启服务 ✓ 见 setUserCookie）
let USER_COOKIE = String(process.env.HN_BILI_COOKIE || '').trim() || readCookieFile();
export function personalizedOn() {
    return !!USER_COOKIE;
}
// 扫码登录成功后调用：换掉当前 cookie，并写到 data/.bili-cookie 持久化 ✓
export function setUserCookie(cookie) {
    USER_COOKIE = String(cookie || '').trim();
    favCache = null;
    feedCache = null;
    // ⚠️ 这个也必须清 ✗ —— whoAmI 会把结果缓存 10 分钟，
    //    换了 cookie 还留着旧的 null，个人中心就会一直显示"已失效" ✗
    //    （2026/10/17 真踩到了：扫完码状态还是 valid:false）
    whoCache = null;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(COOKIE_FILE, USER_COOKIE + '\n', { mode: 0o600 });
        return { ok: true, persisted: true, where: COOKIE_FILE };
    } catch (e) {
        console.warn('[bili] cookie 只在内存里生效（写 ' + COOKIE_FILE + ' 失败：' + e.message + '）');
        return { ok: true, persisted: false, where: COOKIE_FILE };
    }
}
// 给"凭据状态"之类的地方用：只说有没有、不泄露内容 ✓
// 只给"把全局小号迁移到管理员名下"用（启动时调用一次 ✓ 不下发浏览器）
export function exportGlobalCookie() {
    return String(USER_COOKIE || '');
}

export function cookieState(ck) {
    const c = ck === undefined ? USER_COOKIE : String(ck || '');
    return {
        on: !!c,
        // source：env/file=全局小号；user=这个用户自己扫码登录的 ✓
        source: c ? (ck !== undefined ? 'user' : process.env.HN_BILI_COOKIE ? 'env' : 'file') : 'none',
        hasSessdata: /SESSDATA=/.test(c),
        hasJct: /bili_jct=/.test(c),
    };
}

// 当前 cookie 是谁（给个人中心显示"已登录：某某"用）—— 10 分钟缓存
// 2026/10/17 P1：支持每个用户各自的 cookie ⇒ 缓存按 cookie 分桶 ✓
let whoCache = new Map(); // cookie -> { at, info }
export async function whoAmI(ck) {
    const c = ck === undefined ? USER_COOKIE : String(ck || '');
    if (!c) return null;
    const hit = whoCache.get(c);
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.info;
    try {
        const nav = await api('https://api.bilibili.com/x/web-interface/nav', {}, { ck: c });
        const info = nav && nav.isLogin ? { uname: nav.uname, mid: nav.mid, level: (nav.level_info || {}).current_level } : null;
        if (!info) {
            // 失效了就别留着：清掉，个人中心会显示"还没登录" ✓
            console.warn('[bili] B站 cookie 已失效（nav 说没登录），清掉');
            if (ck === undefined) setUserCookie('');
        }
        whoCache.set(c, { at: Date.now(), info });
        return info;
    } catch {
        return null;
    }
}

// 把用户 cookie 合进匿名指纹：按键合并，**用户的值优先**
// （匿名那份只有 buvid3/buvid4/b_nut，不会覆盖 SESSDATA ✓）
//
// ⚠️⚠️ 2026/10/17 的大 bug：这里原来写的是
//        for (const part of anon + '; ' + USER_COOKIE) { ... }
//      —— 对**字符串**做 for...of 是**逐字符**遍历 ✗ ⇒ part 只有一个字符，
//      split(';') 后找不到 '=' ⇒ **map 永远是空的** ⇒ 发出去的 Cookie 头是空串 ✗
//      表现：扫码登录明明成功、cookie 也在文件里，但所有"要登录"的接口全是
//      -101 账号未登录 ✗（而匿名接口一切正常，所以特别难发现）
//      现在拎成纯函数 buildCookie(anon, user) + 单测（check-bili.mjs）
export function buildCookie(anon, user) {
    const map = new Map();
    for (const kv of (String(anon || '') + '; ' + String(user || '')).split(';')) {
        const i = kv.indexOf('=');
        if (i < 0) continue;
        const k = kv.slice(0, i).trim();
        const v = kv.slice(i + 1).trim();
        if (k) map.set(k, v);
    }
    return [...map].map(([k, v]) => k + '=' + v).join('; ');
}

// 2026/10/17 P1：支持**每个用户各自的** B站 cookie（普通用户导入自己收藏夹用）
// ck 不传时回落到 USER_COOKIE（管理员的小号 / env / 文件）✓
function mergeCookie(anon, ck) {
    const c = ck === undefined ? USER_COOKIE : String(ck || '');
    if (!c) return anon;
    return buildCookie(anon, c);
}

async function cookieHeader(ck) {
    const f = await fingerprint();
    return mergeCookie(`buvid3=${f.buvid3}; buvid4=${f.buvid4}; b_nut=${f.b_nut}`, ck);
}
// ---------- WBI 签名（查询类接口需要） ----------
const MIXIN = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
let mixinKey = null;
let mixinAt = 0;
async function getMixinKey() {
    if (mixinKey && Date.now() - mixinAt < 6 * 3600e3) return mixinKey;
    // nav 接口未登录也返回 wbi_img，不需要登录
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: { 'User-Agent': UA, Referer: REFERER, Cookie: await cookieHeader() },
    }).then((x) => x.json());
    const img = r.data.wbi_img.img_url.split('/').pop().split('.')[0];
    const sub = r.data.wbi_img.sub_url.split('/').pop().split('.')[0];
    const raw = img + sub;
    mixinKey = MIXIN.map((i) => raw[i]).join('').slice(0, 32);
    mixinAt = Date.now();
    return mixinKey;
}
async function signedQuery(params) {
    const key = await getMixinKey();
    const all = { ...params, wts: Math.floor(Date.now() / 1000) };
    const q = Object.keys(all)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
        .join('&');
    const w_rid = crypto.createHash('md5').update(q + key).digest('hex');
    return `${q}&w_rid=${w_rid}`;
}
// ---------- 统一请求 ----------
// ---------- 出站限速 + 412 熔断（2026/10/19，用户："只减少限流的可能"）----------
// 为什么需要：所有用户的请求都从**同一个服务器 IP** 出去，B站 是按 IP 限流（412）。
//   一旦打出 412，窗口会被"继续打"不断延长 —— 越急越糟。
// 所以做两件事：
//   ① **限速**：对 api.bilibili.com 做令牌桶（默认 6 次/秒，突发 12），排队而不是硬打
//   ② **熔断**：收到 412 ⇒ 立刻停打 6 分钟，期间所有请求**直接失败**（调用方用缓存/降级），
//      不再去撞墙 —— 这样一次限流最多影响 6 分钟，而不是半小时
const BILI_MIN_INTERVAL = Number(process.env.HN_BILI_MIN_INTERVAL || 160); // 两次请求最小间隔(ms)
const BILI_BLOCK_MS = Number(process.env.HN_BILI_BLOCK_MS || 6 * 60 * 1000); // 412 后静默多久
// ⚠️ 2026/10/19 用户明确："限流的时候也可以听歌，**不要限制听歌方面的功能**"，
//    并追加："**刷新相关推荐也别限制**——会影响心动模式选曲"。
//    所以这三类**完全不走**限速和熔断：
//      · playurl        取流
//      · pagelist       补 cid
//      · archive/related 相关推荐（心动模式的候选池）
//    其余端点（view / search / fav-list / tags / 个性化 feed）照常限速 + 熔断。
const PLAYBACK_ENDPOINT = /\/x\/player\/(playurl|pagelist)|\/x\/web-interface\/archive\/related/;
let biliNextAt = 0; // 下一次允许发车的时刻
let biliBlockedUntil = 0; // 熔断截止时间
export function biliBlockedFor() {
    return Math.max(0, biliBlockedUntil - Date.now());
}
export function isPlaybackEndpoint(url) {
    return PLAYBACK_ENDPOINT.test(String(url || ''));
}
async function biliGate(url) {
    // 播放链路：不限速、不熔断 —— B站 真拒了就是真拒，让浏览器/前端自己去重试
    if (PLAYBACK_ENDPOINT.test(String(url || ''))) return;
    // 非 api 域（图片/音频 CDN 走 /proxy，不经过这里）不参与限速
    if (!/api\.bilibili\.com/.test(url)) return;
    const left = biliBlockedUntil - Date.now();
    if (left > 0) {
        const err = new Error('B 站限流了（412），' + Math.ceil(left / 60000) + ' 分钟后再试');
        err.biliCode = 'blocked';
        err.reqUrl = url;
        throw err;
    }
    const now = Date.now();
    const wait = Math.max(0, biliNextAt - now);
    biliNextAt = Math.max(now, biliNextAt) + BILI_MIN_INTERVAL;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function api(path, params, { wbi = false, ck } = {}) {
    const query = wbi
        ? await signedQuery(params)
        : new URLSearchParams(params).toString();
    const url = `${path}?${query}`;
    await biliGate(url);
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: REFERER, Cookie: await cookieHeader(ck) },
    });
    const text = await res.text();
    let r;
    try {
        r = JSON.parse(text);
    } catch {
        // 被限流/风控时 B 站会返回一张 HTML 错误页。
        // 不这样处理的话前台会看到 "Unexpected token '<'"，完全不知道发生了什么。
        if (res.status === 412) biliBlockedUntil = Date.now() + BILI_BLOCK_MS; // 熔断
        const err = new Error(
            res.status === 412
                ? 'B 站限流了（412），过一会儿再试'
                : 'B 站返回了非 JSON（多半是被限流/风控了），过一会儿再试'
        );
        err.biliCode = 'non-json';
        err.httpStatus = res.status;
        err.reqUrl = url;
        throw err;
    }
    if (r.code !== 0) {
        // -412 / -352 这类风控码也当限流处理（B站 有时用 code 而不是 HTTP 412）
        if (r.code === -412 || r.code === -352 || r.code === -509) biliBlockedUntil = Date.now() + BILI_BLOCK_MS;
        const err = new Error(`B站接口 ${r.code}: ${r.message}`);
        err.biliCode = r.code;
        err.reqUrl = url;
        throw err;
    }
    return r.data;
}
// ---------- 对外三个接口 ----------
export async function search(keyword, page = 1) {
    const d = await api(
        'https://api.bilibili.com/x/web-interface/wbi/search/type',
        { keyword, page, page_size: 20, search_type: 'video' },
        { wbi: true }
    );
    return (d.result || [])
        // 课程等条目没有 bvid，点了也取不到流，直接不返回
        // 失效的也一并筛掉（搜索接口没有 attr/state，只能靠标题，见 looksDead）
        .filter((v) => v.bvid && !looksDead(v))
        .map((v) => ({
            bvid: v.bvid,
            title: String(v.title || '').replace(/<[^>]+>/g, ''), // 去掉 <em> 高亮标签
            author: v.author,
            duration: v.duration,
            cover: v.pic
                ? v.pic.startsWith('//')
                    ? 'https:' + v.pic
                    : v.pic.replace(/^http:/, 'https:')
                : '',
        }));
}
// 解析一个 bvid（用户贴链接 / 导入歌单时用）。
// 2026/10/19：加 10 分钟内存缓存 —— 同一条链接反复贴、或几个人同时导入同一份歌单时，
// 不该每次都去打 view（view 正是最早被 412 的那个端点）。
const resolveCache = new Map();
export async function resolve(bvid) {
    const hit = resolveCache.get(bvid);
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.data;
    const d = await api('https://api.bilibili.com/x/web-interface/view', { bvid });
    const data = {
        bvid,
        // 分P 视频只播第 1P（见 firstCidOf 的注释）——这里也统一
        cid: firstCidOf(d),
        title: d.title,
        // up 主名：播放条标题下面那行显示它（用户要求，原来那里是我调试用的码率）
        author: d.owner?.name || '',
        duration: d.duration,
        cover: d.pic,
        pages: d.pages?.length ?? 1,
        // 分区（2026/10/19 加）：只在服务端内部用（`/api/home` 之类不返回它，
        // 前端也不需要）。分类"这首歌是不是音乐"就靠它 —— 见 MUSIC_TIDS。
        tid: typeof d.tid === 'number' ? d.tid : null,
        tname: String(d.tname || ''),
    };
    resolveCache.set(bvid, { at: Date.now(), data });
    if (resolveCache.size > 500) resolveCache.delete(resolveCache.keys().next().value);
    return data;
}
// 取流地址缓存：上游有效期约 120 分钟，这里留 90 分钟余量。
// ⚠️ 但**客户端的 src 可能留得更久**（标签页开着不动）—— 那时地址早过期了，
//    浏览器会报 "The element has no supported sources"，而且再点播放也没用
//    （src 没变）。所以支持 fresh:true **绕开这个缓存**重取一次，
//    前端在音频 error 事件里会带着它来重试（见 check-frontend 的错误重试）。
const cache = new Map();
const TTL = 90 * 60e3;
export async function getAudio(bvid, cid, { fresh = false } = {}) {
    const k = `${bvid}:${cid}`;
    const hit = cache.get(k);
    if (!fresh && hit && Date.now() - hit.at < TTL) return hit.data;
    const d = await api('https://api.bilibili.com/x/player/playurl', {
        bvid,
        cid,
        fnval: 16, // DASH
        fnver: 0,
        fourk: 1,
    });
    const tracks = d.dash?.audio;
    if (!tracks?.length) {
        throw new Error('没拿到 DASH 音频轨。返回结构: ' + JSON.stringify(d).slice(0, 300));
    }
    const TIER_ORDER = [30280, 30232, 30216];
    const best =
        TIER_ORDER.map((id) => tracks.find((t) => t.id === id)).find(Boolean) ||
        tracks.slice().sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    const data = { url: best.baseUrl, quality: best.id, bandwidth: best.bandwidth };
    // 把这个取流地址的域名登记成可信 —— 否则 /proxy 的白名单会把它拒了
    //（2026/10/15 的 "no supported source" 事故就是这么来的）
    trustHost(best.baseUrl);
    cache.set(k, { at: Date.now(), data });
    return data;
}
function summarizeAudio(track) {
    if (!track) return null;
    if (Array.isArray(track)) {
        if (!track.length) return null;
        return track.map(summarizeAudio);
    }
    return {
        id: track.id,
        kbps: Math.round((track.bandwidth ?? 0) / 1000),
        codecs: track.codecs,
    };
}
async function probePlayurl(bvid, cid, fnval) {
    const d = await api('https://api.bilibili.com/x/player/playurl', {
        bvid,
        cid,
        fnval,
        fnver: 0,
        fourk: 1,
    });
    return {
        quality: d.quality,
        audio: summarizeAudio(d.dash?.audio) || [],
        flac: summarizeAudio(d.dash?.flac?.audio),
        dolby: summarizeAudio(d.dash?.dolby?.audio),
        accept_quality: d.accept_quality,
        accept_description: d.accept_description,
    };
}
export async function audioDebug(bvid, cid) {
    const 结果 = {
        16: await probePlayurl(bvid, cid, 16),
        [16 | 256]: await probePlayurl(bvid, cid, 16 | 256),
    };
    return { mode: '匿名', 结果 };
}

// ---------- bvid → cid / up 主名（惰性补齐，2026/10/15）----------
// 导入的歌单条目**不带 cid**：一个 4000 首的收藏夹要逐首查 4000 次，不现实。
// 改成"播到那首时再查一次"，查过就记住（进程内缓存）。
// 顺手把 up 主名一起带回来 —— 播放条下面那行要显示 up 主，
// **同一次 /view 请求就能拿到**，不用为此多打一次接口（用户对 B 站限流很敏感）。
const infoCache = new Map();
export async function infoOf(bvid, cid, authorHint) {
    const k = String(bvid ?? '').trim();
    if (!k) throw new Error('缺少 bvid');
    // cid 和 up 主名都已经知道 → 一次请求都不打（前端会把已知的带过来）
    if (cid && authorHint) return { cid: String(cid), author: String(authorHint) };
    const hit = infoCache.get(k);
    // 缓存命中且 cid 对得上：缺什么补什么，能不请求就不请求
    if (hit && (!cid || String(cid) === hit.cid)) {
        if (!hit.author && !hit.authorTried) return refetch(k);
        if (authorHint || hit.author) return { cid: String(cid || hit.cid), author: hit.author || String(authorHint || '') };
    }
    return refetch(k);
}
// ---------- 失效视频的判据（2026/10/16 用户："应该筛选掉已经失效的视频"）----------
// 判据都是**实测校准**出来的，不是猜的（见 PROJECT.md 里那次 probe）：
//   · 收藏夹：整页 39 条 attr:0、唯一的失效条目 attr:9 且标题就是「已失效视频」
//   · view/相关推荐：正常稿件 state 全是 0
//   · 搜索接口**没有** attr/state 字段 ⇒ 那边只能看标题
//   · ⚠️ `attribute_v3` 正常视频也是非 0（4/28/5），**绝不能**拿它当判据（会误杀）
const DEAD_TITLE = /^已失效视频$|^已删除|稿件不可见|视频已失效|无法查看|该视频不存在/;

// 收藏夹条目的 B站 标签（2026/10/19 用户要求：按 tag 剔掉音游曲）
// 收藏夹/搜索接口都不带 tags，只有这个端点有，而且**一首一次**。
// 所以只给"可疑项"用（scripts/classify-fav-tags.mjs 在本机跑，必要时经
// /api/admin/fav-tags 走服务器出口）。
export async function tagsOf(bvid) {
    // ⚠️ `api()` 返回的是**body.data**（不是整个 body）—— 第一版写成 `d.data` 就永远是空数组，
    //    结果抓了 112 条全是 []，还没报错（2026/10/19 踩的）。
    const d = await api('https://api.bilibili.com/x/tag/archive/tags', { bvid });
    return (Array.isArray(d) ? d : []).map((x) => String((x && x.tag_name) || '')).filter(Boolean);
}

export function looksDead(m) {
    if (!m || !m.bvid) return true;
    const t = String(m.title || '').trim();
    if (!t) return true;
    if (DEAD_TITLE.test(t)) return true;
    if (typeof m.attr === 'number' && (m.attr & 1)) return true; // 收藏夹的"失效"位
    if (typeof m.state === 'number' && m.state !== 0) return true; // view/相关推荐的稿件状态
    return false;
}

// 分P 视频只播**第 1 个分P**的音频（用户 2026/10/16 要求）。
// ⚠️ B 站 /view 返回的 `d.cid` 是"默认分P"：匿名请求时通常就是第 1P，
//    但它**不是契约**（带 cookie、带 p 参数、或 B 站改行为时会变），
//    所以只要返回里有 pages，就明确取 page=1 那一条，别赌 d.cid。
export function firstCidOf(viewData) {
    const pages = viewData && viewData.pages;
    if (Array.isArray(pages) && pages.length) {
        const p = pages.find((x) => x && x.cid != null && Number(x.page) === 1) || pages[0];
        if (p && p.cid != null) return String(p.cid);
    }
    return viewData && viewData.cid != null ? String(viewData.cid) : '';
}

// 真正去问 B 站。author 拿不到也记下来（authorTried），别每播一次问一次
// 2026/10/19：`/view` 被 412 限流时，**播放不能跟着挂** ⇒ 先退回 pagelist 拿 cid。
//   pagelist 是另一个端点（限流阈值不同，实测 412 期间仍可用），author 拿不到就先空着。
async function refetch(k) {
    let owner = '';
    try {
        const d = await api('https://api.bilibili.com/x/web-interface/view', { bvid: k });
        const cid = firstCidOf(d);
        if (!cid) throw new Error('这个视频取不到 cid: ' + k);
        owner = String(d.owner?.name || '');
        const info = { cid, author: owner, authorTried: true };
        infoCache.set(k, info);
        return { cid: info.cid, author: info.author };
    } catch (e) {
        // view 挂了（412/网络）⇒ 只用 pagelist 拿 cid，保证"还能播"
        const cid = await pagelistCid(k);
        if (!cid) throw e; // 连 pagelist 都没拿到 ⇒ 真的取不到，原样抛
        const prev = infoCache.get(k) || {};
        const info = { cid, author: prev.author || owner || '', authorTried: !!prev.author };
        infoCache.set(k, info);
        return { cid: info.cid, author: info.author };
    }
}

// 只取 cid（分P 第 1 个），走 /x/player/pagelist（不依赖 view）
async function pagelistCid(bvid) {
    try {
        const d = await api('https://api.bilibili.com/x/player/pagelist', { bvid });
        const list = Array.isArray(d) ? d : d && d.list;
        if (Array.isArray(list) && list.length) {
            const p = list.find((x) => x && Number(x.page) === 1) || list[0];
            if (p && p.cid != null) return String(p.cid);
        }
    } catch {}
    return '';
}

// 把 B 站那几个"稿件没了"的错误码翻成人话（播到失效视频时给用户看的）
// 62002 稿件不可见 / -404 视频不存在 / 62004 稿件审核中
export function friendlyBiliError(err) {
    const code = err && err.biliCode;
    if (code === 62002 || code === -404 || code === 62004) return '这个视频已经失效了（B站：' + (err.message || code) + '）';
    return null;
}

// 兼容老名字：只关心 cid 的地方用它
export async function cidOf(bvid, cid) {
    return (await infoOf(bvid, cid)).cid;
}

// ---------- 收藏夹（导入歌单用，2026/10/15 加）----------
// 这三个都是**匿名**能用的：B 站游客也能搜用户、看别人的公开收藏夹。
// 私密收藏夹会返回 -403，那是 B 站不让看，我们没法绕（也不该绕）。

// 从用户输入里认出"这其实是个 UID"。B 站搜索框认这些写法，我们也跟着认：
//   17800413                纯数字
//   uid17800413             站内搜索框的写法（用户最自然会这么打）
//   UID:17800413 / uid 17800413
//   https://space.bilibili.com/17800413    直接粘个人主页链接
// 都不匹配就返回 null，交给按名字搜。
// 导出是为了能离线测（scripts/check-bili.mjs）——
// 这种纯字符串解析最容易漏写法，用户已经抓到过一次（uid<数字> 没认出来）
export function parseUid(keyword) {
    const kw = String(keyword ?? '').trim();
    const patterns = [
        /^uid[:\s：]*(\d{1,20})$/i,
        /^(\d{1,20})$/,
        /(?:space\.)?bilibili\.com\/(?:space\/)?(\d{1,20})(?:[/?#]|$)/i,
    ];
    for (const re of patterns) {
        const m = kw.match(re);
        if (m) return m[1];
    }
    return null;
}

// 按用户名**或 UID** 搜人。
// UID 优先（B 站的搜索接口拿数字当关键词是搜不到人的，实测 0 条），
// UID 查不到再退回按名字搜 —— 因为用户名也可能长得很像数字。
export async function searchUser(keyword) {
    const kw = String(keyword ?? '').trim();
    if (!kw) return [];
    const mid = parseUid(kw);
    if (mid) {
        try {
            return [await userByMid(mid)];
        } catch {
            /* 不是有效的 UID，往下按名字搜 */
        }
    }
    const d = await api(
        'https://api.bilibili.com/x/web-interface/wbi/search/type',
        { keyword: kw, page: 1, page_size: 20, search_type: 'bili_user' },
        { wbi: true }
    );
    return (d.result || [])
        .filter((u) => u.mid)
        .map((u) => ({
            mid: String(u.mid),
            name: String(u.uname || '').replace(/<[^>]+>/g, ''),
            avatar: u.upic ? (u.upic.startsWith('//') ? 'https:' + u.upic : u.upic.replace(/^http:/, 'https:')) : '',
            sign: String(u.usign || '').replace(/<[^>]+>/g, ''),
            fans: u.fans ?? 0,
        }));
}

// 直接按 UID（mid）查用户。
// ⚠️ 用 web-interface/card，**不要**用 space/wbi/acc/info ——
// 后者匿名请求直接 -352 风控，实测三条路只有 card 通（2026/10/15 验证过）
export async function userByMid(mid) {
    const d = await api('https://api.bilibili.com/x/web-interface/card', { mid: String(mid).trim() });
    const c = d?.card;
    if (!c?.mid) throw new Error('没有这个 UID 的用户');
    return {
        mid: String(c.mid),
        name: String(c.name || ''),
        avatar: c.face ? (c.face.startsWith('//') ? 'https:' + c.face : c.face.replace(/^http:/, 'https:')) : '',
        sign: String(c.sign || ''),
        fans: c.fans ?? d.follower ?? 0,
    };
}

// 这个用户**默认收藏夹**的 id。
// B 站返回的 attr 里，默认收藏夹是 0，别的是一堆位标志（实测 2 / 22 / …）。
// 所以先按 attr===0 找，再退回"标题里带默认"，最后退回第一个。
export function defaultFavFolder(folders) {
    if (!folders?.length) return null;
    return (
        folders.find((f) => f.attr === 0) ||
        folders.find((f) => String(f.title).includes('默认')) ||
        folders[0]
    );
}

// 某个用户建过的收藏夹（`attr` 0=默认 2/22=普通 …）。
// ⚠️ 用 created/list（分页版），不要用 created/list-all ——
// 后者匿名请求 returns code=0 但 data=null，白折腾
export async function listFavFolders(mid, ck) {
    const out = [];
    for (let pn = 1; pn <= 5; pn++) {
        const d = await api('https://api.bilibili.com/x/v3/fav/folder/created/list', { up_mid: mid, pn, ps: 20 }, { ck });
        for (const f of d?.list || []) {
            out.push({
                mediaId: String(f.id),
                title: f.title,
                count: f.media_count ?? 0,
                attr: f.attr, // 0=默认收藏夹，其他值是位标志（实测 2 / 22 / …）
                isPrivate: (f.attr & 1) === 1,
            });
        }
        if (!d?.has_more) break;
    }
    return out;
}

// 收藏夹里的条目（分页，**一页最多 40**：实测 ps=41 就 code=-400。
// 一开始我只试了 50 报错就以为上限是 20，白白多花一倍请求 —— 2026/10/15 纠正）。
// 4843 首：40/页 = 122 次；20/页 = 243 次。
export async function listFavItems(mediaId, pn = 1, ps = 40, ck) {
    const d = await api('https://api.bilibili.com/x/v3/fav/resource/list', {
        media_id: mediaId,
        pn,
        ps,
        platform: 'web',
        order: 'mtime',
        type: 0,
        tid: 0,
    }, { ck });
    const items = (d.medias || [])
        // type 2 是视频；别的（音频/专栏/合集）没有可播的 bvid，跳过
        // 失效的也筛掉：整页 39 条 attr:0、唯一的失效条目 attr:9 且标题「已失效视频」
        // （实测校准过，见 looksDead 上方注释）
        .filter((m) => m.bvid && (m.type === 2 || m.type === undefined) && !looksDead(m))
        .map((m) => ({
            bvid: m.bvid,
            title: String(m.title || '').replace(/<[^>]+>/g, ''),
            author: m.upper?.name || '',
            cover: m.cover ? (m.cover.startsWith('//') ? 'https:' + m.cover : m.cover.replace(/^http:/, 'https:')) : '',
            duration: Number(m.duration) || 0,
        }));
    return { items, hasMore: !!d.has_more, title: d.info?.title || '', count: d.info?.media_count ?? 0 };
}

// ---------- 相关推荐（当前播放曲目的"B 站相关推荐"前十首）----------
// 用户 2026/10/16：「歌单那一栏下面再加一栏"相关推荐"，显示的是当前播放曲目的
// b 站相关推荐那一栏的前十首，每首的按钮只有那个图表化的播放和下一首就行了」。
// 用的就是 B 站播放页右侧那一栏同一个接口（/x/web-interface/archive/related）。
// 上游"相关推荐"的**原始列表**按 bvid 缓存 20 分钟 ✓
// ⚠️ 注意：只缓存**上游**，最终挑哪 10 首必须**每次重算** ——
//    否则"每次换一批"就被缓存吃掉了 ✗（2026/10/17 线上实测就是这样：
//    同一个种子连拉两次结果完全一样，我一度以为是挑拣逻辑的锅 ✗）
const relRaw = new Map(); // bvid -> { at, items }
async function rawRelated(bvid) {
    const hit = relRaw.get(bvid);
    if (hit && Date.now() - hit.at < 20 * 60e3) return hit.items;
    const d = await api('https://api.bilibili.com/x/web-interface/archive/related', { bvid });
    const items = (Array.isArray(d) ? d : []).filter((m) => m && m.bvid).map(mapRelItem);
    relRaw.set(bvid, { at: Date.now(), items });
    return items;
}

export async function related(bvid, limit = 10) {
    const want = String(bvid || '').trim();
    if (!/^BV[0-9A-Za-z]{10}$/.test(want)) throw new Error('bvid 不合法');
    const n = Math.max(1, Number(limit) || 10);

    // ① 匿名的"相关推荐"（上游缓存 20 分钟 ✓）：永远可用，作为基本盘
    const base = await rawRelated(want);

    // ② 配了小号 cookie 时，再混进"为你推荐"流 —— 它才是会推**没听过的冷门曲**的那一份 ✓
    //    随机取 12 首（不是永远取前 12 首）⇒ 每次进来都不一样 ✓
    const personal = await personalFeed();
    const pool = personal && personal.length ? [...pickRandom(personal, 12), ...base] : base;

    // ③ 过滤：别推它自己、别推失效的、别推最近刚看过的；每个 UP 主最多 2 首
    const items = rankCandidates(pool, { exclude: want, limit: n, maxPerAuthor: 2, recent: recentSet() });
    rememberShown(items);
    // ④ 顺手把"标题里就能解析出来的歌姬 / P主"附在每一条上（2026/10/19）：
    //    纯本地正则、**零额外请求**。好处：`view` 被 412 限流时（creators 整批失败），
    //    心动模式的"同歌姬 ≥6 降权"和 P主权重照样有值 —— 实测标题解析覆盖
    //    歌姬 91% / P主 83%，比现去问 view 稳得多。
    //    ⚠️ 这只是"补字段"，不参与任何过滤/删歌。
    const withMeta = items.map((it) => {
        const voices = parseVoiceList(it.title);
        const voice = voices[0] || '';
        const creatorRaw = cleanCreatorName(parseCreator('', it.title, it.author || '').name || '');
        const creators = canonCreatorSeries(creatorRaw);
        const creator = creators[0] || '';
        return { ...it, voice, voices, voiceKnown: isVoiceKnown(voice), creator, creators };
    });
    return { items: withMeta, personalized: !!personal };
}

// ---------- "为你推荐"流（登录态才有意义）----------
// ⚠️ 2026/10/17 实测：**全新小号**的"为你推荐"是泛热门 ✗
//    （第一页里是数学题、游戏、生活区…一条音乐都没有），
//    而且这个流**不带 tname/tid 分区字段** ⇒ 没法按分区过滤 ✗
//    ⇒ 直接采信它会让相关推荐**变差**。所以加一道**自动闸门**：
//      只有"看起来像我们要的那类内容"的比例够高时才用，否则整份忽略 ✓
//      小号用一阵子、有观看历史之后，这个比例会自己上来 ⇒ 闸门自动打开 ✓
//    关键词按用户的实际口味（VOCALOID / Utaite / 术力口）写，
//    以后要换题材改这个数组就行 ✓
const MUSIC_HINTS = [
    '初音', 'ミク', 'ボカロ', 'vocaloid', '术力口', 'ボーカロイド', '重音', 'テト',
    '鏡音', '镜音', '巡音', 'リン', 'ルカ', 'meiko', 'kaito', 'gumi', 'flower',
    'utau', '歌ってみた', '翻唱', 'covered', 'cover', 'feat', 'feat.', 'オリジナル',
    '原创曲', '本家投稿', 'official', 'mv', 'remix', '作曲', 'niconico', 'ニコニコ',
];
export function musicish(title, author = '') {
    const s = (String(title || '') + ' ' + String(author || '')).toLowerCase();
    return MUSIC_HINTS.some((k) => s.includes(k.toLowerCase()));
}
export function musicishRatio(items) {
    if (!items || !items.length) return 0;
    return items.filter((x) => musicish(x.title, x.author)).length / items.length;
}
// 闸门门槛：至少 30% 看起来像音乐目才采信（泛热门流一般是 0~10% ✗）
const FEED_MIN_RATIO = 0.3;

let feedCache = null;
async function personalFeed() {
    if (!USER_COOKIE) return null;
    const now = Date.now();
    if (feedCache && now - feedCache.at < 25 * 60e3) return feedCache.ok ? feedCache.items : null;
    try {
        const d = await api(
            'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd',
            { ps: 30, fresh_type: 4, feed_version: 'V8', homepage_ver: 1 },
            { wbi: true }
        );
        const list = (d && (d.item || d.items)) || [];
        const items = list.filter((m) => m && m.bvid).map(mapRelItem);
        const ratio = musicishRatio(items);
        const ok = items.length >= 8 && ratio >= FEED_MIN_RATIO;
        feedCache = { at: now, ok, items };
        if (ok) {
            console.log('[bili] 个性化推荐流可用：' + items.length + ' 条，其中 ' + Math.round(ratio * 100) + '% 像音乐目');
        } else {
            console.log(
                '[bili] 个性化推荐流**这次不用**：' + items.length + ' 条里只有 ' + Math.round(ratio * 100) +
                    '% 像音乐目（小号还没养出观看历史 ⇒ 这个流是泛热门，用了反而更差）'
            );
        }
        return ok ? items : null;
    } catch (e) {
        console.warn('[bili] 个性化推荐流失败，降级匿名: ' + e.message);
        feedCache = { at: now, ok: false, items: [] };
        return null;
    }
}

function pickRandom(arr, k) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, k);
}

// 最近给你看过的（治"同一个 bvid 永远同一份列表"✓ 用户 2026/10/17 反馈"太多雷同"）
// 进程内记忆，上限 60 首；重启就清空（无所谓 ✓）
const RECENT_MAX = 60;
const recentShown = new Map(); // bvid -> 记入时间（Map 保序，最早的在前）
function rememberShown(items) {
    for (const it of items) {
        recentShown.delete(it.bvid);
        recentShown.set(it.bvid, Date.now());
    }
    while (recentShown.size > RECENT_MAX) {
        recentShown.delete(recentShown.keys().next().value);
    }
}
export function recentSet() {
    return new Set(recentShown.keys());
}

// ---------- 扫码登录小号（2026/10/17，管理员在「个人中心」里用）----------
// 为什么不用无头浏览器：B站 能通过 navigator.webdriver 之类认出自动化 ✗，
// 反而更容易被风控。而扫码登录有**接口**：
//   generate → {url, qrcode_key}   （url 就是二维码里该编的东西）
//   poll     → data.code: 86101 未扫码 / 86090 已扫码待确认 / 0 成功
// 成功那一步，B站 会在响应的 Set-Cookie 里**把 cookie 交出来** ✓
// ⇒ 全程在服务器 IP 上完成，用户的电脑根本不碰 ✓ 最干净 ✓
const QR_LOGIN_GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const QR_LOGIN_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const QR_TMP_DIR = path.join(os.tmpdir(), 'hnmusic-qr');

// 把一段文本画成二维码 PNG，返回 data URL（用系统里的 hn-qr，不是 npm 依赖 ✓）
function renderQr(text) {
    return new Promise((resolve, reject) => {
        try {
            fs.mkdirSync(QR_TMP_DIR, { recursive: true });
        } catch {
            /* ignore */
        }
        const out = path.join(QR_TMP_DIR, 'qr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.png');
        execFile('/usr/local/bin/hn-qr', [text, out], { timeout: 10000 }, (err) => {
            if (err) return reject(new Error('二维码生成失败：' + err.message));
            fs.readFile(out, (e2, buf) => {
                fs.unlink(out, () => {});
                if (e2) return reject(new Error('二维码读取失败：' + e2.message));
                resolve('data:image/png;base64,' + buf.toString('base64'));
            });
        });
    });
}

export async function startQrLogin() {
    const d = await api(QR_LOGIN_GEN, {});
    const url = d && d.url;
    const key = d && d.qrcode_key;
    if (!url || !key) throw new Error('B站 没给二维码');
    const png = await renderQr(url);
    console.log('[bili] 已生成扫码登录二维码（key ' + key.slice(0, 8) + '…）');
    return { qrcode_key: key, png };
}

// 轮询扫码结果。成功时直接把 cookie 换掉（并尽量持久化）
export async function pollQrLogin(key, ck) {
    if (!key) throw new Error('缺少 qrcode_key');
    // ⚠️ 这里必须用**裸 fetch**：要从 Set-Cookie 头里取 SESSDATA/bili_jct，
    //    api() 只返回 JSON body，会把头丢掉 ✗
    const res = await fetch(QR_LOGIN_POLL + '?qrcode_key=' + encodeURIComponent(key), {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    });
    const j = await res.json().catch(() => null);
    if (!j || j.code !== 0 || !j.data) throw new Error('B站 轮询失败：' + (j && j.message));
    const code = Number(j.data.code);
    if (code === 86101) return { state: 'waiting' }; // 还没扫
    if (code === 86090) return { state: 'scanned' }; // 扫了没确认
    if (code === 86100) return { state: 'expired' }; // 过期了
    if (code === 86038) return { state: 'expired' };
    if (code !== 0) return { state: 'other', code, message: j.data.message || '' };

    // 成功：从 Set-Cookie 里凑出我们需要的几个
    const wanted = new Map();
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of raw) {
        const first = String(line).split(';')[0];
        const i = first.indexOf('=');
        if (i < 0) continue;
        const k = first.slice(0, i).trim();
        const v = first.slice(i + 1).trim();
        if (['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID'].includes(k)) wanted.set(k, v);
    }
    if (!wanted.get('SESSDATA')) {
        return { state: 'error', message: '登录成功但没拿到 SESSDATA（B站 可能改了登录接口）' };
    }
    const cookie = [...wanted].map(([k, v]) => k + '=' + v).join('; ');
    // P1：把 cookie **交给调用方**去存到"这个用户"名下 ✓ 不再覆盖全局小号 ✓
    const saved = ck === undefined ? setUserCookie(cookie) : { persisted: false, where: '(caller)' };
    // 顺便问一句"现在是谁"，好告诉用户登录的是哪个账号
    let who = '';
    let mid = null;
    try {
        const nav = await api('https://api.bilibili.com/x/web-interface/nav', {});
        who = (nav && nav.uname) || '';
        mid = (nav && nav.mid) || null;
    } catch {
        /* ignore */
    }
    console.log('[bili] 小号扫码登录成功：' + (who || '(未知)') + '  cookie 已' + (saved.persisted ? '落盘' : '仅内存'));
    return { state: 'ok', uname: who, mid, persisted: saved.persisted, cookie };
}

// ---------- 收藏到小号的 B站 收藏夹（2026/10/17 用户要求）----------
// 用户的用法："我平时没事往那个账号里面收藏夹塞点曲子，推流就会好了"
// —— 靠人工收藏慢慢把这个小号的偏好养出来 ✓
// ⚠️ 这是**写操作**：必须有 bili_jct（CSRF 令牌，是**另一个** cookie，
//    只给 SESSDATA 不够 ✗）；没有就明确报错，别静默失败 ✓
// ⚠️ 只给管理员用（路由里校验），而且只手动点，频率极低 ⇒ 不招风控 ✓
let favCache = null; // { at, mid, folderId, folderName }

// 判断"是不是 cookie 失效"这类错误 —— 顺手把死 cookie 清掉，别一直拿它去打 B站 ✗
function isNotLoggedIn(e) {
    return !!(e && (e.biliCode === -101 || /未登录/.test(String(e.message || ''))));
}
function notLoggedInError() {
    return new Error('小号登录已失效 —— 去「个人中心」重新扫一次码就好');
}

async function favTarget(ck) {
    if (!USER_COOKIE) throw new Error('还没配小号 cookie（HN_BILI_COOKIE）');
    const csrf = (String(USER_COOKIE).match(/bili_jct=([^;]+)/) || [])[1];
    if (!csrf) throw new Error('cookie 里缺 bili_jct —— 收藏是写操作，必须有这个令牌（从浏览器 cookie 里再复制一个）');
    if (favCache && Date.now() - favCache.at < 30 * 60e3) return { ...favCache, csrf };
    // ⚠️ 优先用 cookie 里自带的 DedeUserID —— 少一次 nav 请求，也少一个失败点 ✓
    //    （2026/10/17：扫码登录后 nav 在应用里莫名返回未登录 ✗ 而同一份 cookie
    //      在 shell 里问 nav 又是 isLogin=True ✓ —— 与其追这个，不如别依赖它）
    let mid = (c.match(/DedeUserID=(\d+)/) || [])[1] || '';
    if (!mid) {
        let nav;
        try {
            nav = await api('https://api.bilibili.com/x/web-interface/nav', {}, { ck });
        } catch (e) {
            if (isNotLoggedIn(e)) {
                console.warn('[bili] 小号 cookie 已失效，清掉它（等管理员重新扫码）');
                setUserCookie('');
                throw notLoggedInError();
            }
            throw e;
        }
        if (!nav || !nav.isLogin || !nav.mid) {
            setUserCookie('');
            throw notLoggedInError();
        }
        mid = String(nav.mid);
    }
    // 取收藏夹列表，优先"默认收藏夹"
    const d = await api('https://api.bilibili.com/x/v3/fav/folder/created/list-all', { up_mid: mid }, { ck });
    let list = (d && d.list) || [];
    // ⚠️ 全新小号**一个收藏夹都没有** ✗（2026/10/17 实测：报"这个小号还没有收藏夹"）
    //    ⇒ 自动建一个默认的，用户就不用先去 B站 手动建了 ✓
    if (!list.length) {
        const made = await pubPost('https://api.bilibili.com/x/v3/fav/folder/add', {
            title: '默认收藏夹',
            privacy: '0',
            csrf,
        });
        const newId = made && made.data && made.data.id;
        if (!newId) throw new Error('自动创建收藏夹失败，请先在这个小号的 B站 主页手动建一个收藏夹');
        console.log('[bili] 给小号自动建了「默认收藏夹」(media_id ' + newId + ')');
        list = [{ id: newId, title: '默认收藏夹' }];
    }
    const folder = list.find((x) => /默认/.test(String(x.title || ''))) || list[0];
    favCache = { at: Date.now(), mid, folderId: folder.id, folderName: folder.title };
    console.log('[bili] 收藏目标：小号 mid=' + mid + ' 的「' + folder.title + '」(media_id ' + folder.id + ')');
    return { ...favCache, csrf };
}

// 带 cookie 的 POST（B站 的写接口收表单，返回 JSON）
async function pubPost(url, params) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            Referer: 'https://www.bilibili.com/',
            Origin: 'https://www.bilibili.com',
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: await cookieHeader(),
        },
        body: new URLSearchParams(params).toString(),
    });
    const j = await res.json().catch(() => null);
    if (!j) throw new Error('B站 返回了非 JSON（可能被风控了）');
    if (j.code !== 0) throw new Error('B站 拒绝：' + j.code + ' ' + (j.message || ''));
    return j;
}

// 读**任意 B站 用户**的公开收藏夹（2026/10/17 用户要求：首页"为你推荐"显示
// 他大号「灰诺-」默认收藏夹的前几首 ✓ 收藏夹是公开数据 ⇒ 不需要登录 ✓）
export async function publicFavFolder(mid, limit = 6) {
    const u = String(mid || '').trim();
    if (!/^\d+$/.test(u)) throw new Error('mid 不合法');
    const n = Math.max(1, Math.min(Number(limit) || 6, 100)); // 心动模式兜底要看第 40-100 首 ✓
    const fl = await api('https://api.bilibili.com/x/v3/fav/folder/created/list-all', { up_mid: u });
    const list = (fl && fl.list) || [];
    if (!list.length) return { folder: null, total: 0, items: [] };
    const folder = list.find((x) => /默认/.test(String(x.title || ''))) || list[0];
    // ⚠️ ps 最大只能 20（B站 限制 ✗ 传 100 会 -400）⇒ 需要多少就翻多少页 ✓
    const pages = Math.max(1, Math.ceil(n / 20));
    const items = [];
    for (let pn = 1; pn <= pages; pn++) {
        const d = await api('https://api.bilibili.com/x/v3/fav/resource/list', {
            media_id: String(folder.id),
            pn: String(pn),
            ps: '20',
        });
        for (const m of (d && d.medias) || []) {
            items.push({
                bvid: m.bvid,
                title: m.title,
                author: (m.upper && m.upper.name) || '',
                cover: m.cover || '',
                duration: m.duration || 0,
                // 播放量：心动模式的兜底要按它筛（<2 万）✓ 2026/10/17
                view: Number((m.cnt_info && m.cnt_info.play) || 0) || 0,
            });
        }
        if (items.length >= n) break;
    }
    return { folder: folder.title, total: folder.media_count || 0, items: items.slice(0, n) };
}


// ===== P主（制作人）识别（2026/10/17 用户需求）=====
// 三个真实例子校准过：
//   Music:Achroa                          ⇒ Achroa
//   CG・Music : mopi (https://twitter…)   ⇒ mopi
//   作編曲 : イルマ / IRUMA                ⇒ イルマ
// 简介里没有任何这类字样 ⇒ 退到标题（最后一个【】= P主，排除标签词/歌姬名）
// 都判不出 ⇒ name:''（前端不惩罚 ✓ 宁可漏掉也不要误伤）
// 声库（歌姬）判定（2026/10/17 用户提醒：别把歌姬当 P主 ✗）
//   ① 精确名单（常见的）
//   ② **特征词匹配**：名字里带 ミク/リン/レン/ルカ/テト/可不/ずんだ/ナースロボ…
//      或带 SV / NT / AI / V5 / V6 这类声库后缀 ⇒ 一律当歌姬 ✓
// 2026/10/19 用户核对后补的一批（"建议加的都加，还有 音街ウナ / 70D"）：
//   カゼヒキ 鳴花ヒメ 鳴花ミコト 狐子 雨衣 VY1 宮舞モカ 唄音ウタ 星尘Infinity 洛天依
//   乐正绫 Ci flower 冥鳴ひまり 葛駄夜音 ネヂェム 心華 りむる 健音テイ 暗鳴ニュイ
//   湯鬱声からす 雪歌ユフ 紲星あかり 永夜Minus 双葉湊音 Fukase MAYU 琴葉茜 琴葉葵
//   春日部つむぎ 70D
// （音街ウナ 原来就有；用户点名要再确认一遍 ⇒ 留在这里，同时在 VOICE_HINT 里加了 "ウナ"）
const VOICE_WORDS = /^(初音ミク|鏡音リン|鏡音レン|巡音ルカ|MEIKO|KAITO|重音テト|可不|ずんだもん|小春六花|花隈千冬|足立レイ|歌愛ユキ|結月ゆかり|GUMI|IA|ONE|LUMi|星界|裏命|羽累|櫻花あおい|無來|令音ミク|音街ウナ|SF-A2|猫村いろは|v flower|flower|カゼヒキ|カゼヒキβ|カゼヒキV|鳴花ヒメ|鳴花ミコト|狐子|雨衣|VY1|宮舞モカ|唄音ウタ|星尘Infinity|星尘|洛天依|乐正绫|Ci flower|冥鳴ひまり|葛駄夜音|ネヂェム|心華|りむる|健音テイ|暗鳴ニュイ|湯鬱声からす|雪歌ユフ|紲星あかり|永夜Minus|双葉湊音|Fukase|MAYU|琴葉茜|琴葉葵|春日部つむぎ|70D|白寝ねんね|欲音ルコ|欲音ルコ♀|欲音ルコ♂|miki|開発コードmiki|ナースロボ_タイプT|ナースロボ＿タイプT|ナースロボタイプT|ナースロボ|MIKU|初音未来|结月缘|镜音铃|镜音连|巡音流歌)$/i;
const VOICE_HINT = /(ミク|リン|レン|ルカ|テト|可不|ずんだ|六花|千冬|レイ|ユキ|ゆかり|ナースロボ|歌愛|音街|猫村|フヱル|ゲキヤク|デフォ子|ずんだもん|ずん子|きりたん|東北|VOICEROID|VOCALOID|CeVIO|Neutrino|SynthV|\bSV\b|\bNT\b|\bAI\b|V[3-6]|＿タイプ|タイプT|_type|星界|知声|裏命|羽累|無來|ボカコレ|足立|花隈|初音|重音|鏡音|巡音|ついな|ついなちゃん|カゼヒキ|鳴花|ひまり|つむぎ|唄音|ウナ|星尘|天依|乐正|ヂェム|心華|りむる|Fukase|MAYU|琴葉|紲星|雪歌|健音|暗鳴|湯鬱|宮舞|永夜|双葉|狐子|雨衣|VY1|70D|白寝|欲音ルコ|ルコ|MIKU|HATSUNE|初音未来|结月缘|結月緣|镜音铃|镜音连|巡音流歌)/i;
// 统一判断"这是不是歌姬名"（精确名单 + 特征词 双保险 ✓）
export function isVoiceName(s) {
    const v = String(s || '').trim();
    if (!v) return false;
    return VOICE_WORDS.test(v) || VOICE_HINT.test(v);
}
// 歌姬名"规范化"：把写法变体收敛成同一个名字。
// 不然 "花隈千冬" 和 "花隈千冬SV"、"flower" 和 "Ci flower / v_flower" 会被当成两个人，
// 心动模式"同歌姬 ≥6 首"就永远凑不够（2026/10/19 预演时发现的）
export function canonVoice(v, _noFallback) {
    let s = String(v || '').trim();
    if (!s) return '';
    s = s.replace(/^Vo\.?\s*/i, '').trim(); // "Vo.鏡音レン" 这种前缀
    s = s.replace(/[（(][^）)]*[）)]/g, '').trim(); // 去掉括号补注
    s = s.replace(/\[[^\]]*\]/g, '').trim(); // 去掉 [V6] 之类
    s = s.replace(/\s*(SV|V\d|β|α|AI|NT|SP)$/i, '').trim(); // 去掉版本后缀
    s = s.replace(/^星尘Infinity$/i, '星尘');
    // 同一个歌姬的多种写法 ⇒ 归一（不然"同歌姬"判定会漏）
    if (/^(MIKU|HATSUNE MIKU|初音未来|初音ミク)$/i.test(s)) return '初音ミク';
    if (/^初音ミク/.test(s)) return '初音ミク'; // 初音ミクDark / 初音ミクSoft / 初音ミクV4X 等同一个人
    if (/^(结月缘|結月緣|結月ゆかり)$/.test(s)) return '結月ゆかり';
    if (/^(镜音铃|鏡音リン)$/.test(s)) return '鏡音リン';
    if (/^(镜音连|鏡音レン)$/.test(s)) return '鏡音レン';
    if (/^(巡音流歌|巡音ルカ)$/.test(s)) return '巡音ルカ';
    if (/flower$/i.test(s)) return 'flower'; // v flower / v_flower / Ci flower
    if (/^カゼヒキ/.test(s)) return 'カゼヒキ';
    if (/^欲音ルコ/.test(s)) return '欲音ルコ';
    if (/^(開発コード)?miki$/i.test(s)) return 'miki';
    if (/^ナースロボ/i.test(s)) return 'ナースロボ_タイプT';
    if (/^鳴花ヒメ/.test(s)) return '鳴花ヒメ';
    if (/^鳴花ミコト/.test(s)) return '鳴花ミコト';
    if (/^音街ウナ/.test(s)) return '音街ウナ';
    if (/^重音(テト|TETO|teto)/i.test(s)) return '重音テト';
    if (/^(TETO|teto|テト)$/.test(s)) return '重音テト';
    if (/^足立レイ/.test(s)) return '足立レイ';
    if (/^結月ゆかり/.test(s)) return '結月ゆかり';
    // 还认不出（带 ft./别名/后缀）⇒ 从名单里找**最长的一个被包含的名字**
    //   例：歌愛ユキft.しろいさい ⇒ 歌愛ユキ；ナースロボ＿タイプＴ-Alice ⇒ ナースロボ＿タイプＴ
    //   ⚠️ 递归调用必须带 true，否则自己会一直命中自己（2026/10/19 踩过爆栈）
    if (!_noFallback) {
        const names = VOICE_WORDS.source
            .replace(/^\^\(|\)\$$/g, '')
            .split('|')
            .filter((x) => x && x.length >= 3)
            .sort((a1, b1) => b1.length - a1.length);
        for (const n of names) {
            if (s.includes(n)) return canonVoice(n, true);
        }
    }
    return s;
}
// 标题里有没有"这是术力口"的信号（整串是歌姬名 / 写了 vocaloid / **括号里**是歌姬名）
// 2026/10/19 加：剔音游曲时要用它 ——「音游曲里是术的、以及联名 VOCALOID 的不要删」。
// ⚠️ 只认括号里的名字，不认"标题里随便出现这几个字"：
//    「チエルカ／エソテリカ - ツミキ × 宮下遊 [maimai でらっくす]」里的「チエル**カ**」…
//    实测「チエルカ」会误命中「ルカ」（巡音ルカ）⇒ 把一首 maimai 曲当成术曲留下 ✗
export function looksLikeVocaloidSong(title) {
    const t = String(title || '');
    if (!t) return false;
    if (/vocaloid|ボカロ|术力口|術力口|ボカコレ/i.test(t)) return true;
    if (VOICE_WORDS.test(t.trim())) return true;
    for (const m of t.matchAll(/【([^】]{1,40})】|「([^」]{1,40})」|\[([^\]]{1,40})\]|（([^）]{1,40})）/g)) {
        const inner = String(m[1] || m[2] || m[3] || m[4] || '').trim();
        if (inner && (VOICE_WORDS.test(inner) || VOICE_HINT.test(inner))) return true;
    }
    return false;
}
const TAG_WORDS = /^(本家投稿|中文字幕|原创|原创pv|搬运|完整版|中文|翻自|付|無|off ?vocal|instrumental|mv|pv|ボカロ|vocaloid)$/i;
// 找"创作署名"那一行（用户 2026/10/17 给的真实例子）：
//   Music:Achroa                                  ✓
//   CG・Music : mopi (…)                          ✓
//   ▼Lyrics,Music&Arrangement：栗山夕璃           ✓ ← 关键词后面还有别的词
//   作編曲 : イルマ / IRUMA                        ✓
//   MAIN VOCAL&CHORUS：Flower＆重音TETOSV          ✗ 这是**歌姬**，不是 P主（不能认）
const MUSIC_KEYS = /(?:^|[^a-z])((?:lyrics|作詞|作曲|編曲|アレンジ|arrangement|music|音楽)[^:：\n]{0,30})\s*[:：]\s*(.+)/i;

// "简介看起来是不是一首歌"（2026/10/19 用户要求）：
//   不像歌名的标题（`热异常但是升三十二度`、`Teto超有感情的对你唱了【热异常】`、`欲音ルコ你干嘛哎哟`）
//   ⇒ **扒简介**：简介里有 作詞/作曲/編曲/歌/Illust/Mix… 这些制作署名的才算歌。
//   ⚠️ 限流（拿不到简介）时**直接跳过**这一首 —— 用户明说："限流状态这种必须看简介的就直接跳过"。
const SONG_CREDIT =
    /作詞|作词|作曲|編曲|编曲|編成|歌：|歌:|Vo[:：]|Vocal|唄[:：]|Lyrics|lyric|Music[:：]|調声|调声|イラスト|插图|插圖|Illust|動画[:：]|MIX[:：]|Mix[:：]|マスタリング|ギター|Guitar|ベース|Bass|ドラム|Drum|Piano|ピアノ|原曲|主唱|演唱|歌唱|改编|改編|特別鳴謝|特别鸣谢|UST|アレンジ|arrange/gi;
export function descLooksLikeSong(desc) {
    const d = String(desc || '');
    if (!d) return false;
    const hits = (d.match(SONG_CREDIT) || []).length;
    if (hits >= 2) return true;
    // 单个强信号也算（原曲 / 主唱 / 作詞 / 作曲 …）
    return /作詞|作词|作曲|編曲|编曲|歌[:：]|Vo[:：]|原曲|主唱|演唱|歌唱|改编|改編/i.test(d);
}

// "这不可能是 P主"的字样（防抖：解析结果常是 `中文字幕` / `𝟒𝐊中字` / `自用` / `本家演唱`：
// 2026/10/19 预演里一整串 カンザキイオリ 的歌，P主 全被识别成这些搬运标签 ⇒ 权重和判重全废）
const JUNK_CREATOR = /字幕|中字|翻译|繁中|简中|汉化|搬运|转载|授权|自用|大家一起用|合集|合辑|重发|重投|补档|補檔|再投|ファンソング|fansong|記念|纪念|企画|コンパス|本家演唱|本家|官方|official|music ?video|MV|PV|4K|𝟒𝐊|高清|高保真|无损|96khz|カラオケ|ニコカラ|串烧|XFD|FES|Live|演唱会|现场|One-?Man|ver\.?$|^\d+$/i;

export function cleanCreatorName(v) {
    const out = String(v || '')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/（[^）]*）/g, ' ')
        .replace(/\s*[\/／].*$/, ' ') // "/搬运"、"/ iruma_azalea" 这种后缀一律砍掉（`【あばらや/搬运】` ⇒ あばらや）
        .replace(/[▶→►▼・･]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[-—–\s]+|[-—–\s]+$/g, '')
        .replace(/[_]+\s*$/, '') // `栗山夕璃_` 这种尾部下划线
        .replace(/[_\-]\s*[A-Za-z][A-Za-z0-9 ._\-]*$/, '') // `栗山夕璃_kuriyama yuri` 这种“中文名_拉丁名”
        .replace(/[《『].*$/, '') // `栗山夕璃《dizzy dizzy》…` 后面的全是歌名
        .slice(0, 30)
        .trim();
    // 搬运标签 / 字幕组名 / 合集名 都不是 P主 ⇒ 当成"识别不出来"
    if (JUNK_CREATOR.test(out)) return '';
    return out;
}

// 从标题里找"歌姬"。
// 2026/10/19 预演时发现：原来只认**括号里**的名字，于是
//   `君ならどうしたっけ / 鳴花ミコト`、`Overkill / MIKU`、`Fukase feat.可不`
// 这类"曲名 / 歌姬"的写法全解析不出来 ⇒ 心动模式"同歌姬 ≥6 首"永远凑不够 ✗
// 现在按"把握从高到低"依次试：括号里 → feat./ft. 后面 → "/" 后面的尾巴 → 全标题
// P主 名字"规范化"：把写法变体收敛，否则心动模式的"连续三首同 P主"和"同 P主降权"
// 都会因为 "r-906" / "r-906 様" / "r-906 Remix" / "中日CC字幕" 而失效
// （2026/10/19 预演实测：r-906 连推 12 首都没被三连ban拦住，就是这么漏的）
export function canonCreator(v) {
    let s = String(v || '').trim();
    if (!s) return '';
    s = s.replace(/[（(][^）)]*[）)]/g, ' ').trim(); // 去括号补注
    s = s.replace(/https?:\/\/\S+/g, ' ').trim();
    s = s.replace(/\s*(様|さん|ちゃん|くん|P|Official|official|CHANNEL|Channel|channel|チャンネル)$/g, '').trim();
    s = s.replace(/\s*(Remix|REMIX|remix|アレンジ|arrange|Arrange|Style|style)$/g, '').trim();
    s = s.replace(/\s*[\/／].*$/, '').trim(); // "はるまきごはん/弹唱" 这种斜杠后缀
    s = s.replace(/\s*[×＆&]\s*.*$/, '').trim(); // `カンザキイオリ × Guiano` / `煮ル果実＆john` 这种合作 ⇒ 记主 P主
    s = s.replace(/\s+/g, ' ').trim();
    // 同一个人的中/日/英文写法收敛成一个（2026/10/19 用户指出：图里 9 首其实全是
    // カンザキイオリ，却被识别成 神绮一织 / 𝟒𝐊中字 / 繁中字 / 自制字幕 ⇒ 权重失效 ✗）
    for (const [re, canon] of CREATOR_ALIAS) if (re.test(s)) return canon;
    return s;
}

// P主 别名表（以后遇到同一个人多种写法，往这里加一行）
const CREATOR_ALIAS = [
    // ⚠️ 2026/10/19 用户纠正：**黑柿子 和 カンザキイオリ 才是同一个人**，
    //    神绮一织是**另一个人** ⇒ 千万别混在一起（会把两个人的权重串成一条）
    [/^(黑柿子|カンザキイオリ|iori ?kanzaki|kanzaki ?iori)$/i, 'カンザキイオリ'],
    [/^(神綺一織|神綺一织)$/, '神绮一织'],
    // MIMI 的官方号在收藏里叫 `MIMI_music`，同一个人 ⇒ 归一（不然"同P主权重"算不到一起）
    [/^(MIMI|MIMI_music|ミミ)$/i, 'MIMI'],
    [/^(rinri|rinri_0e|rinri0e)$/i, 'rinri'], // 同一个 P主（频道名）
    [/^(栗山夕璃|栗山|栗山夕璃_kuriyama ?yuri|kuriyama ?yuri)$/i, '栗山夕璃'],
    [/^(じん|JIN|自然の敵P|自然之敌P)$/i, 'じん'],
    [/^(春卷饭|春卷飯|はるまきごはん|harumakigohan|春巻きごはん)$/i, 'はるまきごはん'],
    [/^(虻瀬犬|虻瀬|あぶせ|Abuse|abuse)$/i, '虻瀬犬'],
    // ⚠️ 2026/10/19 用户纠正：**柚乃ロネ / すずねP / LonePi 是三个不同的人** ⇒ 千万不要合并！
    //    （我曾因为 `【柚乃ロネ（LonePi）】` 这种写法误以为是一人马甲，已撤回。）
];

// 歌姬名是否**精确**在本地名单里（HINT 命中的怪字符串不算）
export function isVoiceKnown(v) {
    const s = canonVoice(v);
    return !!s && VOICE_WORDS.test(s);
}

// 合作曲：sasakure.UK×DECO*27 / A＆B / A, B ⇒ 拆成多个人
// （2026/10/19 用户要求：合作作曲要把**两个 P主 都算进池子**）
export function canonCreatorSeries(v) {
    const raw = String(v || "");
    if (!raw) return [];
    const out = [];
    for (const one of raw.split(/[×＆&,，、]/)) {
        const c = canonCreator(cleanCreatorName(one));
        if (c && !out.includes(c)) out.push(c);
    }
    return out;
}

// 一段文字里的**第一个**歌姬名（支持 "A・B" / "A＆B" / "A / B" 这种多人写法）
function voiceInText(text) {
    const s = String(text || '');
    if (!s) return '';
    if (/hatsune\s*miku/i.test(s)) return '初音ミク'; // "Hatsune Miku" 中间有空格，别被 split 拆坏
    for (const one of s.split(/[・、,，/／×＆&+＋\s]+/)) {
        const t = one.trim();
        if (t && isVoiceName(t)) return canonVoice(t);
    }
    if (isVoiceName(s.trim())) return canonVoice(s.trim());
    return '';
}

// 一段文字里的**所有**歌姬名（去重、保持出现顺序）
function voicesInText(text) {
    const out = [];
    const s = String(text || '');
    for (const one of s.split(/[・、,，×＆&+＋\s]+/)) {
        const t = one.trim();
        if (!t) continue;
        const v = isVoiceName(t) ? canonVoice(t) : voiceInText(t);
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

// 标题里**所有**歌姬（多歌姬合作曲要用）
export function parseVoiceList(title) {
    const s = String(title || '');
    const tags = [...s.matchAll(/【([^】]{1,40})】|\[([^\]]{1,40})\]|（([^）]{1,40})）|「([^」]{1,40})」/g)]
        .map((x) => (x[1] || x[2] || x[3] || x[4] || '').trim())
        .filter(Boolean);
    for (const g of tags) {
        const vs = voicesInText(g);
        if (vs.length) return vs;
    }
    const ft = s.match(/(?:feat|ft)\.?\s*([^\]】\[\s/／]{2,24})/i);
    if (ft) {
        const vs = voicesInText(ft[1]);
        if (vs.length) return vs;
    }
    // 括号外：`曲名 / 歌姬` 只取 / 之后那一段（用户说明：/ 前面通常是 P主）
    const parts = s.split(/[／/]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const vs = voicesInText(parts[parts.length - 1]);
        if (vs.length) return vs;
    }
    return voicesInText(s);
}

export function parseVoiceOf(title) {
    const s = String(title || '');
    const tags = [...s.matchAll(/【([^】]{1,40})】|\[([^\]]{1,40})\]|（([^）]{1,40})）|「([^」]{1,40})」/g)]
        .map((x) => (x[1] || x[2] || x[3] || x[4] || '').trim())
        .filter(Boolean);
    // ① 括号里（最把握）—— 多人写法 "A・B" 取第一个
    for (const g of tags) {
        const v = voiceInText(g);
        if (v) return v;
    }
    // ② feat. / ft. 后面
    const ft = s.match(/(?:feat|ft)\.?\s*([^\]】\[\s/／]{2,16})/i);
    if (ft) {
        const v = voiceInText(ft[1]);
        if (v) return v;
    }
    // ③ "曲名 / 歌姬名" 的尾巴；也支持 `曲名 - 歌姬名`、`曲名 Vo.歌姬`
    //    （2026/10/19 统计：`解独剤 - 歌愛ユキ`、`アポフェニア - 重音テトSV` 这种不带括号的写法，
    //      原来解析不出歌姬 ⇒ 心动模式会把它当成"不像歌名"而丢掉）
    const parts = s.split(/[／/]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const v = voiceInText(parts[parts.length - 1]);
        if (v) return v;
    }
    const dashM = s.match(/[-–—]\s*([^-–—]{2,24})$/);
    if (dashM) {
        const v = voiceInText(dashM[1].replace(/^Vo\.?\s*/i, '').trim());
        if (v) return v;
    }
    // ④ 保底：整条标题扫一遍（含空格/・分隔的多人写法）
    return voiceInText(s);
}
export function parseCreator(desc, title, upName) {
    for (const line of String(desc || '').split(/\r?\n/)) {
        const m = line.match(MUSIC_KEYS);
        if (!m) continue;
        const name = cleanCreatorName(m[2]);
        if (!name) continue;
        if (/^[\d\s.,:：\/\\\-]+$/.test(name)) continue; // 纯数字/符号 ⇒ 不是名字
        if (TAG_WORDS.test(name)) continue;
        if (isVoiceName(name)) continue; // ⚠️ 值是歌姬名（如"Flower＆重音TETOSV"）⇒ 这行不是 P主 ✗
        return { name, how: 'desc', voice: parseVoiceOf(title) };
    }
    // 【本家投稿】【官方投稿】⇒ 投稿的 B站 用户**就是 P主 本人** ✓（2026/10/17 用户说明）
    if (upName && /本家投稿|官方投稿|本家投[稿稿]/.test(String(title || ''))) {
        return { name: String(upName).trim().slice(0, 30), how: 'up', voice: parseVoiceOf(title) };
    }
    // `【转载】栗山夕璃_kuriyama yuri - 『泡泡』…` ⇒ 转载标题前半段是**原作者** ⇒ 当 P主
    {
        const rm = String(title || '').match(/^[【\[（(]\s*(?:转载|搬运|授权转载|补档)\s*[】\]）)]\s*([^\s【】\-–—『」]+)/);
        if (rm) {
            const nm = cleanCreatorName(rm[1]);
            if (nm && nm.length >= 2 && !isVoiceName(nm) && !TAG_WORDS.test(nm)) {
                return { name: nm, how: 'title', voice: parseVoiceOf(title) };
            }
        }
    }
    // '曲名 - P主 feat.歌姬' 这种写法（`このゆびとまれ - LonePi feat.重音テト/花隈千冬`）
    {
        const df = String(title || '').match(/[-–—]\s*([^-–—]{2,30}?)\s*(?:[\/／]\s*)?(?:feat|ft)\.?/i);
        if (df) {
            const nm = cleanCreatorName(df[1]);
            if (nm && !isVoiceName(nm) && !TAG_WORDS.test(nm)) return { name: nm, how: 'title', voice: parseVoiceOf(title) };
        }
    }
    // `曲名 / P主 feat.歌姬`（`无法进行排毒 / 栗山夕璃 feat. 重音 TETO SV＆初音MIKU`）
    {
        const sf = String(title || '').match(/[\/／]\s*([^\/／]{2,30}?)\s*(?:feat|ft)\.?/i);
        if (sf) {
            const nm = cleanCreatorName(sf[1]);
            if (nm && !isVoiceName(nm) && !TAG_WORDS.test(nm)) return { name: nm, how: 'title', voice: parseVoiceOf(title) };
        }
    }
    // 2026/10/19：**"写在越后面的那个名字"才是 P主**（术力口标题惯例）——
    //   候选 = 括号里的名字（去掉垃圾词/歌姬）+ 括号外的全大写拉丁名（MARETU / DECO*27 这种）。
    //   取位置最靠后的那个。
    //   实例：`ファンネイター（施魅者）-初音ミク｜MARETU 热心市民C先生` ⇒ MARETU ✓
    //         `【音街ウナ】讨厌・讨厌・JIGAHIDAI！【くらげP】`         ⇒ くらげP ✓（JIGAHIDAI 是歌名）
    //         `【GUMI・鏡音リン】捉迷藏依存症【かいりきベア】`          ⇒ かいりきベア ✓
    {
        const CAPS_STOP = /^(MV|PV|OP|ED|HD|CV|AV|DJ|BGA|BOF|MIX|REMIX|LIVE|AI|NT|SV|VO|CD|DVD|FS|XFD|BPM|TV|CM|STYLE|VER|VERSION|EDIT|COVER|RMX|ARRANGE|CLUB|FULL)$/;
        const tt = String(title || '');
        const cands = [];
        // 全角圆括号（…）里多半是**中文译名**（`【LonePi】語彙力のないラブソング（没有词汇的情歌）`）
        // ⇒ 标记 weak，只在没有别的候选时才用它（2026/10/19 用户抓到）
        for (const m of tt.matchAll(/【([^】]{1,40})】|\[([^\]]{1,40})\]|（([^）]{1,40})）|「([^」]{1,40})」/g)) {
            const nm = cleanCreatorName(m[1] || m[2] || m[3] || m[4] || '');
            if (!nm || nm.length > 30) continue;
            if (isVoiceName(nm) || TAG_WORDS.test(nm)) continue;
            cands.push({ pos: m.index, name: nm, weak: !!m[3] });
        }
        for (const m of tt.matchAll(/(?<![A-Za-z])([A-Z][A-Z0-9*.\-]{2,})(?![A-Za-z])/g)) {
            const nm = m[1];
            if (CAPS_STOP.test(nm) || isVoiceName(nm)) continue;
            cands.push({ pos: m.index, name: nm });
        }
        if (cands.length) {
            // 优先用"强"候选（【】/[]/「」/全大写）；全角括号里的译名只有在没别的候选时才用
            const strong = cands.filter((c) => !c.weak);
            const pool0 = strong.length ? strong : cands;
            // 2026/10/19 用户定的 B 方案：**已知 P主 优先**（名单从收藏夹统计出来，出现 ≥2 次的算）
            //   `【flower】旁人POCKY【かいりきベア】【情人节限定】` ⇒ 命中 かいりきベア，
            //   而不是末尾的活动标签「情人节限定」
            if (knownCreators && knownCreators.size) {
                let best = null;
                for (const c of pool0) {
                    const key = canonCreator(c.name);
                    const cnt = knownCreators.get(key) || 0;
                    if (!cnt) continue;
                    if (!best || cnt > best.cnt || (cnt === best.cnt && c.pos > best.pos)) best = { name: c.name, pos: c.pos, cnt };
                }
                if (best) return { name: best.name, how: 'title', voice: parseVoiceOf(title) };
            }
            const use = pool0.slice().sort((a, b) => a.pos - b.pos);
            return { name: use[use.length - 1].name, how: 'title', voice: parseVoiceOf(title) };
        }
    }
    // ===== 特例（2026/10/19 用户指定）=====
    // P主「砂糖の缶詰」：简介不写 P主、标题不写 P主、也没有"本家投稿"字样 ✗
    // 只能靠"投稿的 UP 主就是他"来认 ✓
    // 特征：标题里出现他最常用的歌姬「唄音ウタ」+ UP 主是「砂糖の缶詰」
    if (upName && /砂糖の缶詰/.test(String(upName)) && /唄音ウタ|呗音ウタ|唄音うた/.test(String(title || ''))) {
        return { name: '砂糖の缶詰', how: 'case', voice: parseVoiceOf(title) };
    }
    // 退到标题：括号里最后一个就当 P主
    //   ⚠️ 不能只认【】：术力口 很多标题用 **[栖山]xxx** 或 **（栖山）xxx**（2026/10/17 用户抓到）
    const tags = [
        ...String(title || '').matchAll(/【([^】]{1,40})】|\[([^\]]{1,40})\]|（([^）]{1,40})）|「([^」]{1,40})」/g),
    ]
        .map((x) => (x[1] || x[2] || x[3] || x[4] || '').trim())
        .filter(Boolean);
    // 单括号的情况：标题形如「[栖山]曲名」⇒ 括号在**开头**就取它（用户抓到的 5 首都是这样）
    const head = String(title || '').trim().match(/^[【\[（「]([^】\]）]{1,30})[】\]）」]\s*\S/);
    if (head) {
        const name = cleanCreatorName(head[1]);
        if (name && !TAG_WORDS.test(name) && !isVoiceName(name)) {
            return { name, how: 'head', voice: parseVoiceOf(title) };
        }
    }
    // 「P主 - 曲名」格式（用户 2026/10/17 要求）：
    //   てとら - 話がしたいよ feat.初音ミク  ⇒ てとら
    // 保护：开头不能是【[（( 这类括号（那是标签/歌姬包着的，不是 P主）
    const dash = String(title || '').match(/^([^【\[（(][^【\[（(]{1,23})\s*[-–—－]\s+\S/);
    if (dash) {
        const name = cleanCreatorName(dash[1]);
        if (name && !TAG_WORDS.test(name) && !isVoiceName(name)) {
            return { name, how: 'dash', voice: parseVoiceOf(title) };
        }
    }
    // ⚠️ 「多个括号 ⇒ 最后一个」**优先级最低**（2026/10/17 用户要求）：
    //    因为也有特别冷门的歌姬不在名单里 ⇒ 放最后，前面的规则先试 ✓
    // 2026/10/19 用户抓到实例：`ファンネイター（施魅者）-初音ミク｜MARETU 热心市民C先生`
    //   一排 13 首**全是 MARETU** 的作品，却被识别成搬运号「热心市民C先生」⇒ P主权重失效。
    //   规则：多个括号时，**先找全大写拉丁名（MARETU / Kikuo / DECO*27 这种 P主惯用写法）**，
    //   找不到再退回"最后一个"。
    if (tags.length >= 2) {
        for (const g of tags) {
            if (isVoiceName(g) || TAG_WORDS.test(g)) continue;
            if (/^[A-Z][A-Z0-9*.\-& ]{2,}$/.test(g.trim())) return { name: g, how: 'title', voice: parseVoiceOf(title) };
        }
        // 从后往前找**第一个不是垃圾词**的括号（`【授权转载】`/`【重发】`/`【中文字幕】` 都会跳过）
        for (let i = tags.length - 1; i >= 0; i--) {
            const g = tags[i];
            const nm = cleanCreatorName(g);
            if (!nm || nm.length > 30) continue;
            if (isVoiceName(nm) || TAG_WORDS.test(nm)) continue;
            return { name: nm, how: 'title', voice: parseVoiceOf(title) };
        }
    }
    // `（煮ル果実Remix）` 这种括号里的 Remix 版 ⇒ 括号里那个名字才是 P主
    {
        const rx = String(title || '').match(/[（(]([^）)]{2,24}?)\s*(?:remix|Remix|REMIX|アレンジ)[）)]/);
        if (rx) {
            const nm = cleanCreatorName(rx[1]);
            if (nm && !isVoiceName(nm) && !TAG_WORDS.test(nm)) return { name: nm, how: 'title', voice: parseVoiceOf(title) };
        }
    }
    // 兜底：标题里确实认不出 P主（`君ならどうしたっけ / 鳴花ミコト` 这种只有"曲名/歌姬"的写法），
    // 就用**投稿者**当 P主 —— 但投稿者不能是搬运/字幕/合集类账号（JUNK_CREATOR / TAG_WORDS 挡掉）。
    // 2026/10/19 用户："这几个又全都是同一个 P主" —— 实例是 rinri 的 4 首，
    // 标题里一个 P主 都没写，只能靠投稿者认。
    if (upName) {
        const nm = cleanCreatorName(String(upName));
        if (nm && nm.length <= 30 && !isVoiceName(nm) && !TAG_WORDS.test(nm)) {
            return { name: nm, how: 'up', voice: parseVoiceOf(title) };
        }
    }
    return { name: '', how: 'none', voice: parseVoiceOf(title) };
}

const descCache = new Map(); // bvid -> {name, how, at}
// "不像歌名"的候选：扒简介判断它到底是不是歌（2026/10/19 用户要求）
const songCache = new Map(); // bvid -> {song, at, blocked?}
export async function songcheckOf(bvids) {
    const list = (Array.isArray(bvids) ? bvids : []).filter((x) => /^BV[0-9A-Za-z]{10}$/.test(String(x || '')));
    const out = {};
    for (const bvid of list) {
        const hit = songCache.get(bvid);
        if (hit && Date.now() - hit.at < (hit.blocked ? 60e3 : 24 * 3600e3)) {
            out[bvid] = { song: hit.song, voice: hit.voice || '', voiceKnown: hit.voiceKnown === true, creator: hit.creator || '', creators: hit.creators || [] };
            continue;
        }
        if (biliBlockedFor() > 0) {
            // 限流中 ⇒ 看不到简介 ⇒ 用户要求直接跳过（song=false）
            songCache.set(bvid, { song: false, at: Date.now(), blocked: true });
            out[bvid] = { song: false, voice: '' };
            continue;
        }
        try {
            const d = await api('https://api.bilibili.com/x/web-interface/view', { bvid });
            const song = descLooksLikeSong(d && d.desc);
            // 顺带把歌姬解析出来：标题认不出就用简介里的「歌：xxx」
            const voice = parseVoiceOf(d && d.title) || parseVoiceOf(d && d.desc) || '';
            // 也把 P主 解析一遍（标题认不出时，简介里的「作詞/作曲」行是唯一来源）
            const pc = parseCreator((d && d.desc) || '', (d && d.title) || '', (d && d.owner && d.owner.name) || '');
            const creatorName = canonCreator(cleanCreatorName((pc && pc.name) || ''));
            const creators = canonCreatorSeries(creatorName);
            songCache.set(bvid, { song, voice, voiceKnown: isVoiceKnown(voice), creator: creatorName, creators, at: Date.now() });
            out[bvid] = { song, voice, voiceKnown: isVoiceKnown(voice), creator: creatorName, creators };
        } catch {
            songCache.set(bvid, { song: false, at: Date.now(), blocked: true });
            out[bvid] = { song: false, voice: '' };
        }
    }
    return out;
}

// 批量查 P主（成功的缓存 24 小时；**失败的只缓存 10 分钟**，2026/10/19）
// 熔断期间（412）**直接不打 B站**：返回空，由前端用 related 里"标题解析"出来的
// 歌姬/P主 兜底 —— 用户 2026/10/19："识别p主歌姬在限流期间直接只用走本地的那个方式"。
export async function creatorsOf(bvids) {
    if (biliBlockedFor() > 0) {
        console.warn('[bili] 熔断中（' + Math.ceil(biliBlockedFor() / 1000) + 's）⇒ P主/歌姬 本次只用本地标题解析，不打接口');
        return {};
    }
    const list = (Array.isArray(bvids) ? bvids : []).filter((x) => /^BV[0-9A-Za-z]{10}$/.test(String(x || '')));
    const out = {};
    for (const bvid of list) {
        const hit = descCache.get(bvid);
        // 成功的缓存 24 小时（P主名基本不变）；失败只记 10 分钟，别让一次 412 卡住一小时
        const okTtl = hit && hit.how !== 'error' ? 24 * 3600 * 1000 : 10 * 60 * 1000;
        if (hit && Date.now() - hit.at < okTtl) {
            out[bvid] = { name: canonCreator(hit.name), creators: canonCreatorSeries(hit.name), how: hit.how, voice: hit.voice || '', voices: parseVoiceList(hit.title || ''), voiceKnown: isVoiceKnown(hit.voice), tname: hit.tname || '' };
            continue;
        }
        try {
            const d = await api('https://api.bilibili.com/x/web-interface/view', { bvid });
            const up = (d && d.owner && d.owner.name) || '';
            const rec = { ...parseCreator((d && d.desc) || '', (d && d.title) || '', up), tname: (d && d.tname) || '', at: Date.now() };
            descCache.set(bvid, rec);
            out[bvid] = { name: canonCreator(rec.name), creators: canonCreatorSeries(rec.name), how: rec.how, voice: rec.voice || '', voices: parseVoiceList((d && d.title) || ''), voiceKnown: isVoiceKnown(rec.voice), tname: rec.tname || '' };
        } catch {
            // 2026/10/19：偶尔 412/超时会让"歌姬/P主"识别失败 ⇒ 心动模式的降权就失灵
            // （预演里 30 首有 19 首因此变成"未知"）。这里重试一次，仍失败才记 error。
            try {
                await new Promise((r) => setTimeout(r, 700));
                const d = await api('https://api.bilibili.com/x/web-interface/view', { bvid });
                const up = (d && d.owner && d.owner.name) || '';
                const rec = { ...parseCreator((d && d.desc) || '', (d && d.title) || '', up), tname: (d && d.tname) || '', at: Date.now() };
                descCache.set(bvid, rec);
                out[bvid] = { name: canonCreator(rec.name), how: rec.how, voice: rec.voice || '', tname: rec.tname || '' };
            } catch {
                // 连"标题解析"的结果也一起给前端：view 挂了但标题里往往还是认得出歌姬
                descCache.set(bvid, { name: '', how: 'error', at: Date.now() });
                out[bvid] = { name: '', how: 'error', voice: '', tname: '' };
            }
        }
    }
    return out;
}


// ===== 默认收藏夹缓存（2026/10/17 用户要求）=====// 目的：心动模式每次都要读收藏夹前 40 / 第 41-100 / 第 200 以外 ⇒ 反复打 B站 ✗
// 做法：落盘一个 JSON，**7 天**刷新一次；刷新时把"前 40 首"的变化打到日志 ✓
import { readFileSync as _rfs, writeFileSync as _wfs, existsSync as _exists } from 'node:fs';
const FAV_CACHE_PATH = process.env.HN_FAV_CACHE || '/opt/hnmusic/data/fav-cache.json';
// 每天 **早上 6 点（上海时间）** 刷新一次缓存，而且**只刷最新 15 首**，其余保持不动。
// 用户 2026/10/19 要求：「默认收藏夹更新改为每天早上 6 点更新（如果发送该条信息的时间
// 已经过了六点则更新一次）（注：每次更新默认收藏夹只需要检索前 15 首）」
// 为什么不能全量刷：全量 4800 首 = 125 次 B站 请求，天天这么干就是 412 的温床；
// 而收藏夹只有"最新那几首"会变 —— 心动模式要的第 41-100 / 200 以外那几段，旧的就够用。
const FAV_REFRESH_TOP = 15; // 每天只重新抓最新 15 首
const SH_TZ = 'Asia/Shanghai';
// "最近一个早上 6 点"的时间戳（上海时间；不引时区库，靠 Intl 拿日期再拼 +08:00）
function lastSixAm(now = Date.now()) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: SH_TZ }).format(new Date(now)); // YYYY-MM-DD
    const today6 = Date.parse(day + 'T06:00:00+08:00');
    return now >= today6 ? today6 : today6 - 24 * 3600e3;
}
// 缓存"该不该刷新"：过了今天 6 点、却没在 6 点之后刷过 ⇒ 刷一次
export function favNeedsRefresh(c, now = Date.now()) {
    if (!c || !c.at) return true;
    return c.at < lastSixAm(now);
}
const FAV_CACHE_LIMIT = 5000; // 缓存全部（用户 2026/10/17 要求录入 4000+ 首 ✓）

// ===== 分区（tid）：判断"这首歌是不是音乐" =====
// 用户 2026/10/19：「顺便再清理一下非音乐分区的，默认收藏夹里稍微有些不是」。
// ⚠️ 收藏夹接口（fav/resource/list）**不返回 tid** —— 只有 `view` 有，而一首一次
//    请求：4800 首就是 4800 次，实测把 IP 打成 412（一次 697 个就中）。所以：
//      · 分区表由 `scripts/classify-fav-partitions.mjs` **在本机**慢慢打标签，
//        结果落到 data/fav-tids.json（bvid → tid），服务端只读这份表；
//      · 表里没有的条目**一律保留**（不知道就别删）。
const MUSIC_TIDS = new Set([
    3,   // 音乐（父分区）
    28,  // 原创音乐
    29,  // （音乐子区，实测表里有）
    30,  // VOCALOID·UTAU
    31,  // 翻唱（实测：31 = 翻唱，不是演奏）
    59,  // 演奏
    130, // 音乐综合
    193, // MV（实测：193 = MV，「音街ウナSV 官方MV」就在这儿）
    136, // 音游（实测：136 = 音游。内容基本是"打着歌的实机"，比 17 单机游戏更该留下）
    243, // 说唱
    244, // 电音
    245, // 管弦乐
    246, // 音乐相关（保守起见一起算音乐）
]);
const FAV_TIDS_PATH = process.env.HN_FAV_TIDS || '/opt/hnmusic/data/fav-tids.json';
const CREATOR_STATS_PATH = process.env.HN_FAV_CREATORS || '/opt/hnmusic/data/fav-creators.json';

// ===== P主 白名单（2026/10/19 用户定的 B 方案）=====
// 从收藏夹统计"同一名字出现 ≥2 次"的算"已知 P主"；解析标题时**已知的优先**，
// 之后才退回"取最靠后那个"（后者会被【情人节限定】这类活动标签骗到）。
let knownCreators = new Map();
export function reloadCreatorStats() {
    try {
        const j = JSON.parse(_rfs(CREATOR_STATS_PATH, 'utf8'));
        const list = Array.isArray(j.creators) ? j.creators : [];
        knownCreators = new Map(list.map((x) => [String(x.name), Number(x.count) || 1]));
        console.warn('[bili] P主白名单加载：' + knownCreators.size + ' 个');
    } catch (e) {
        knownCreators = new Map();
        console.warn('[bili] P主白名单未加载（可调 /api/admin/reload-fav-creators 重建）：' + e.message);
    }
    return knownCreators.size;
}
// 从收藏夹缓存统计（标题解析 + UP 主名都算）
export function buildCreatorStats() {
    const c = readFavCache();
    const items = (c && Array.isArray(c.items) && c.items) || [];
    const cnt = new Map();
    const bump = (raw) => {
        const n = canonCreator(cleanCreatorName(String(raw || '')));
        if (!n || n.length < 2 || n.length > 30) return;
        if (isVoiceName(n) || TAG_WORDS.test(n)) return;
        cnt.set(n, (cnt.get(n) || 0) + 1);
    };
    for (const it of items) {
        const pc = parseCreator('', it.title || '', it.author || '');
        if (pc && pc.name) bump(pc.name);
        if (it.author) bump(it.author);
    }
    const creators = [...cnt.entries()]
        .filter(([, n]) => n >= 2)
        .sort((x, y) => y[1] - x[1])
        .map(([name, count]) => ({ name, count }));
    _wfs(CREATOR_STATS_PATH, JSON.stringify({ at: Date.now(), total: items.length, creators }, null, 2));
    knownCreators = new Map(creators.map((x) => [x.name, x.count]));
    console.warn('[bili] P主白名单重建：从 ' + items.length + ' 首统计出 ' + creators.length + ' 个（≥2 次）');
    return { total: items.length, creators: creators.length };
}
// 启动时自动加载（文件不存在就空着，等管理员调 /api/admin/reload-fav-creators 重建）
reloadCreatorStats();
let favRefreshing = null; // 同一时刻只允许一次"每日 15 首"刷新（避免并发重复打 B站）
let favTidsMem = null;
function favTids() {
    if (favTidsMem) return favTidsMem;
    try {
        const j = JSON.parse(_rfs(FAV_TIDS_PATH, 'utf8'));
        favTidsMem = (j && j.tids) || {};
    } catch {
        favTidsMem = {};
    }
    return favTidsMem;
}
export function reloadFavTids() {
    favTidsMem = null;
    favTagsMem = null;
    favDropMem = null;
}

// ===== 标签（2026/10/19 用户要求）=====
// 「以前很喜欢听音游曲，这些不是术会影响检索 ⇒ 删掉 tag 里带 bms / arcaea 之类
//   热门音游的曲子；但**世界计划 / pjsk 不要删**（那是联名 VOCALOID 的音游）」
// 标签同样不在收藏夹接口里（要一首一次 `tag/archive/tags`），所以和分区一样：
// 由 `scripts/classify-fav-tags.mjs` 在本机慢慢抓，结果落 data/fav-tags.json，服务端只读。
// 判定顺序（见 favKeep）：先看"保留标签"，再看"音游标签" —— 保证"是术的 / 联名世界计划"的
// 一律留下（用户明确要求）。
// ⚠️ 这些词只放"足够独特"的：短促的片假名（ルカ / テト / リン）会误命中别的词 ——
//    实测 tag「チエルカ」里就有「ルカ」⇒ 把一首 maimai 曲判成"术"留下 ✗
const KEEP_TAGS = ['vocaloid', 'ボカロ', 'ボーカロイド', '术力口', '術力口', 'ボカコレ', '初音', 'ミク', '重音', '鏡音', '镜音', '巡音', 'kaito', 'meiko', 'gumi', 'flower', 'utau', 'synthv', 'cevio', '世界计划', 'プロセカ', 'project sekai', 'pjsk', '缤纷舞台', 'セカイ', '歌姫', '歌姬'];
const DROP_TAGS = ['bms', 'arcaea', '韵律源点', 'phigros', 'chunithm', '中二节奏', 'maimai', '舞萌', '太鼓', 'deemo', 'cytus', 'osu!', 'osu', 'muse dash', '喵斯', 'bang dream', 'バンドリ', '邦邦', 'd4dj', 'beatmania', 'iidx', 'sound voltex', 'sdvx', 'ongeki', 'オンゲキ', 'wacca', 'jubeat', 'popn', 'ポップン', 'groove coaster', 'ノスタルジア', '音游', '音乐游戏', '游戏音乐', '手元', '音ゲー'];
const FAV_TAGS_PATH = process.env.HN_FAV_TAGS || '/opt/hnmusic/data/fav-tags.json';
// 手工剔除表（用户点名"这几条删掉"的）：bvid 数组。
// 有些条目抓不到音游标签（B站 标签本来就是用户打的，漏得厉害），
// 用户看过一眼说删就行了 —— 这份表就是那个口子，别写死进代码。
const FAV_DROP_PATH = process.env.HN_FAV_DROP || '/opt/hnmusic/data/fav-drop.json';
let favDropMem = null;
function favDropSet() {
    if (favDropMem) return favDropMem;
    try {
        const j = JSON.parse(_rfs(FAV_DROP_PATH, 'utf8'));
        const arr = Array.isArray(j) ? j : (j && j.bvids) || [];
        favDropMem = new Set(arr.map((x) => String(x).trim()).filter(Boolean));
    } catch {
        favDropMem = new Set();
    }
    return favDropMem;
}
let favTagsMem = null;
function favTags() {
    if (favTagsMem) return favTagsMem;
    try {
        const j = JSON.parse(_rfs(FAV_TAGS_PATH, 'utf8'));
        favTagsMem = (j && j.tags) || {};
    } catch {
        favTagsMem = {};
    }
    return favTagsMem;
}
// 返回 'keep' / 'drop' / 'none'（没有标签数据）
// "这是术"的标签（用来豁免"音游实机/DJ 切片"这类：有音游标签但**没有**术标签 ⇒ 剔）
const VOICE_KEEP_TAGS = ['vocaloid', 'ボカロ', 'ボーカロイド', '初音', 'ミク', '重音', '鏡音', '镜音', '巡音', 'kaito', 'meiko', 'gumi', 'flower', 'utau', 'synthv', 'cevio', '术力口', '術力口'];
// 实机 / 谱面 / DJ 切片这类"不是曲子"的标签
const GAMEPLAY_TAGS = ['音游', '音乐游戏', '游戏音乐', '音ゲー', '谱面', '手元'];
function tagVerdict(bvid) {
    const rec = favTags()[bvid];
    if (!rec || !Array.isArray(rec.tags) || !rec.tags.length) return 'none';
    const low = rec.tags.map((t) => String(t).toLowerCase());
    const has = (list) => list.some((k) => low.some((t) => t.includes(k.toLowerCase())));
    // ① 音游实机 / 谱面 / DJ 切片：有"音游类"标签、却**没有**任何"术"标签 ⇒ 剔。
    //    这一条要排在"世界计划豁免"前面 —— 否则"【pjsk】某曲 红谱AP"这种谱面实机
    //    会因为带了 Project SEKAI 标签被保住（2026/10/19 用户点名要删）。
    if (has(GAMEPLAY_TAGS) && !has(VOICE_KEEP_TAGS)) return 'drop';
    if (has(KEEP_TAGS)) return 'keep';
    if (has(DROP_TAGS)) return 'drop';
    return 'none';
}
function favTidOf(bvid) {
    const rec = favTids()[bvid];
    return rec ? rec.tid : undefined;
}
// "这条看起来是首歌吗"（只用在"分区不是音乐"的那些条目上）
// 为什么要这一步：实测 B站 上真有正经曲子被传到别的分区 ——
//   tid=21 日常 里有【官方投稿】幸せ診療所/李音フヱル
//   tid=47 同人·手书 里有【本家投稿】霧雨が降る街で…
//   tid=257 配音 里有【重音テト/MV/中译版】颓废。
// 只看分区就剔会把这些误删，所以"分区非音乐"时再看一眼像不像歌。
const SONG_HINTS = /feat|mv|pv|オリジナル|origina|原创|本家|官方投稿|中译|字幕|歌って|初音|ボカロ|vocaloid|\//i;
// 音乐投稿最常用的命名风格：把歌姬/曲名/P主放在括号里（【…】「…」『…』[ … ]）
const SONG_BRACKETS = /【[^】]*】|「[^」]*」|『[^』]*』|\[[^\]]*\]/;
export function looksLikeSong(it) {
    const t = String((it && it.title) || '');
    if (!t) return false;
    if (musicish(t, (it && it.author) || '')) return true;
    if (isVoiceName(t)) return true;
    if (SONG_BRACKETS.test(t)) return true;
    if (SONG_HINTS.test(t)) return true;
    return false;
}

// "确定不是音乐"的分区：游戏 / 绘画 / 人文历史 / 明星 / 奇怪的新区
// （只对这些做"按分区删"；日常/手书/配音这些"混着曲子的区"不在里面）
const HARSH_TIDS = new Set([17, 172, 4, 19, 20, 65, 66, 228, 162, 137, 267]);

// 2026/10/19 用户要求：「能不能不要留下这种明显不是音乐分区的了」
// （起因：`中文实况【字幕】说谎公主与失明王子【完结】` 一直躺在收藏夹缓存里）
// 标题里出现这些词的，**只要没有任何"术"的信号**就当作非音乐剔掉。
// ⚠️ 必须配合 looksLikeVocaloidSong：`【初音ミク】攻略不可能！？`、`【歌愛ユキ】人生速通法！`
//    这些是正经术曲，不能被"攻略/速通"误伤 ✗
const NON_MUSIC_TITLE = /实况|攻略|教程|录播|解说|开箱|vlog|游戏流程|通关|速通|抽卡|测评|评测|装机|编程|教学|直播回放|整活|试玩|实机演示|混剪|搬运指南|字幕组招|字幕组招募/i;

// 这条收藏条目该不该留（分区 + 标签）
// 导出给 scripts/classify-fav-tags.mjs 做"预报"用 —— 保证脚本打印的去留结果
// 和线上真正执行的完全一致（别写第二份判据，§六 第 22 条那个坑）。
export function favKeepItem(it) {
    return favKeep(it);
}
function favKeep(it) {
    if (!it || !it.bvid) return false;
    const tid = typeof it.tid === 'number' ? it.tid : favTidOf(it.bvid);
    if (tid === 'dead') return false;           // 分类时发现已失效
    // ⓪ 用户点名要删的（手工表）—— 优先级最高，别被后面的规则救回来
    if (favDropSet().has(it.bvid)) return false;
    // ① 是术力口（标题里就有歌姬/ボカコレ/VOCALOID）⇒ 一律留下
    //    （用户 2026/10/19：「音游曲里是术的、还有世界计划/pjsk 那种联名 VOCALOID 的不要删」）
    if (looksLikeVocaloidSong(it.title)) return true;
    // ①.5 标题明显不是音乐（实况/教程/攻略/录播…）且没有任何"术"信号 ⇒ 剔
    //      （用户 2026/10/19：「能不能不要留下这种明显不是音乐分区的了」）
    //      ⚠️ 用 looksLikeVocaloidSong（只认**括号里的歌姬名**/VOCALOID 字样），
    //      不能用 looksLikeSong —— 后者"有【】就算像歌"，会把
    //      `中文实况【字幕】说谎公主…【完结】` 放过去 ✗
    if (NON_MUSIC_TITLE.test(String(it.title || '')) && !looksLikeVocaloidSong(it.title) && tagVerdict(it.bvid) !== 'keep') {
        return false;
    }
    // ② 标签优先：带 VOCALOID / 世界计划 之类"保留标签"的，留下
    const v = tagVerdict(it.bvid);
    if (v === 'keep') return true;
    if (v === 'drop') return false;             // 带 bms / arcaea / 音游 等标签 ⇒ 剔
    // ③ 没有标签数据就按分区判断
    if (typeof tid !== 'number') return true;   // 没打过分区标签 ⇒ 保留
    if (MUSIC_TIDS.has(tid)) return true;       // 音乐分区 ⇒ 留
    // ④ 只对"确定不是音乐"的分区删（游戏 / 绘画 / 人文历史 / 明星 …）。
    //    ⚠️ 日常(21) / 同人·手书(47) / 配音(257) 这些**不在 HARSH_TIDS 里** ——
    //    实测它们里面正经曲子很多（【官方投稿】幸せ診療所投在日常、
    //    VOCALOID 曲被投到手书区…），一按分区剔就会误删。这些分区只由标签来判。
    if (HARSH_TIDS.has(tid) && !looksLikeSong(it)) return false;
    return true;
}

function readFavCache() {
    try {
        if (!_exists(FAV_CACHE_PATH)) return null;
        const j = JSON.parse(_rfs(FAV_CACHE_PATH, 'utf8'));
        if (!j || !Array.isArray(j.items)) return null;
        // ⚠️ 老缓存里会混着**失效视频**（2026/10/19 实测线上 4800 条里有 94 条
        //    "已失效视频"）：这条缓存路径以前没接 looksDead，而心动模式正是从
        //    这份池子里挑歌 ⇒ 会挑到播不出来的。读到就顺手剔掉并回写（自愈），
        //    这样不用等下一次全量刷新，线上第一下读取就干净了。
        const before = j.items.length;
        const clean = j.items.filter((x) => !looksDead(x) && favKeep(x));
        if (clean.length !== before) {
            console.warn('[bili] 收藏夹缓存里剔除了 ' + (before - clean.length) + ' 条（失效 / 非音乐分区）');
            j.items = clean;
            writeFavCache(j);
        }
        return j;
    } catch {
        return null;
    }
}
function writeFavCache(obj) {
    try {
        _wfs(FAV_CACHE_PATH, JSON.stringify(obj));
    } catch (e) {
        console.warn('[bili] 收藏夹缓存写盘失败：' + e.message);
    }
}

// 真正去 B站 拉前 n 首（翻页 ps=20）
async function fetchFavItemsRaw(mid, n, fk) {
    const u = String(mid || '').trim();
    if (!/^\d+$/.test(u)) throw new Error('mid 不合法');
    const fl = await api('https://api.bilibili.com/x/v3/fav/folder/created/list-all', { up_mid: u }, { ck: fk });
    const list = (fl && fl.list) || [];
    if (!list.length) return { folder: null, total: 0, items: [] };
    const folder = list.find((x) => /默认/.test(String(x.title || ''))) || list[0];
    // 一页取 40（`ps=41` 会 -400，实测；见 PROJECT.md §六 收藏夹导入第 11 条）。
    // 原来是 20 ⇒ 4800 首要 250 次请求，每天刷新一次就是在给自己招 412。
    const PER = 40;
    const pages = Math.max(1, Math.ceil(n / PER));
    const items = [];
    for (let pn = 1; pn <= pages; pn++) {
        const d = await api('https://api.bilibili.com/x/v3/fav/resource/list', {
            media_id: String(folder.id),
            pn: String(pn),
            ps: String(PER),
        }, { ck: fk });
        for (const m of (d && d.medias) || []) {
            // 失效条目（attr 位 / 标题「已失效视频」）**不进缓存** ——
            // 这条路径以前漏了 looksDead，结果线上缓存里堆了 94 条播不出来的歌（2026/10/19）
            if (!m || !m.bvid || looksDead(m)) continue;
            const item = {
                bvid: m.bvid,
                title: m.title,
                author: (m.upper && m.upper.name) || '',
                cover: m.cover || '',
                duration: m.duration || 0,
                view: Number((m.cnt_info && m.cnt_info.play) || 0) || 0,
            };
            // 带上分区标签（有就打），并按分区过滤非音乐（2026/10/19 用户要求）
            const tid = favTidOf(item.bvid);
            if (typeof tid === 'number') item.tid = tid;
            if (!favKeep(item)) continue;
            items.push(item);
        }
        if (items.length >= n) break;
    }
    return { folder: folder.title, total: folder.media_count || 0, items: items.slice(0, n) };
}

// 缓存优先（7 天内直接用 ✓ 过期或不存在才去拉 ✓）
// 给收藏夹条目补上"标题解析"出来的歌姬/P主（纯本地正则，零请求）
// 2026/10/19：收藏夹来源的曲子以前 P主/歌姬 全是空的 ⇒ 三连同P主、同P主降权都不生效
function withParsedMeta(it) {
    const voices = parseVoiceList(it && it.title || '');
    const rawC = cleanCreatorName(parseCreator('', (it && it.title) || '', (it && it.author) || '').name || '');
    const creators = canonCreatorSeries(rawC);
    return { ...it, voices, voice: voices[0] || '', voiceKnown: isVoiceKnown(voices[0] || ''), creator: creators[0] || '', creators };
}

export async function favFolderCached(mid, limit = 40, ck, { force = false } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 40, FAV_CACHE_LIMIT));
    const c = readFavCache();
    // ① 还没到"今天 6 点之后" ⇒ 直接用缓存（一次 B站 都不打）
    if (!force && !favNeedsRefresh(c) && Array.isArray(c.items) && c.items.length >= Math.min(n, 40)) {
        return { folder: c.folder, total: c.total, items: c.items.slice(0, n).map(withParsedMeta), cached: true, at: c.at };
    }
    // ② 该刷新了：**只抓最新 15 首**，然后并回缓存（旧的 41-100 / 200 以外那段留着给心动模式用）
    //    并发防护：同一个人刷新时别人正好也在读，别重复打 B站
    if (favRefreshing) {
        const done = await favRefreshing.catch(() => null);
        if (done && Array.isArray(done.items) && done.items.length >= Math.min(n, 40)) {
            return { folder: done.folder, total: done.total, items: done.items.slice(0, n).map(withParsedMeta), cached: true, at: done.at };
        }
    }
    const job = (async () => {
        const old = (c && Array.isArray(c.items) && c.items) || [];
        // 没有缓存（第一次跑）⇒ 只能拉全量当种子；有缓存 ⇒ 只拉 15 首
        const r = old.length
            ? await fetchFavItemsRaw(mid, FAV_REFRESH_TOP, ck)
            : await fetchFavItemsRaw(mid, FAV_CACHE_LIMIT, ck);
        const fresh = r.items || [];
        const freshSet = new Set(fresh.map((x) => x.bvid));
        const merged = old.length ? [...fresh, ...old.filter((x) => !freshSet.has(x.bvid))] : fresh;
        // 变化日志（只看最新 15 首，用户要的就是"今天新收了什么"）
        try {
            const oldTop = new Set(old.slice(0, FAV_REFRESH_TOP).map((x) => x.bvid));
            const newTop = new Set(fresh.slice(0, FAV_REFRESH_TOP).map((x) => x.bvid));
            const added = fresh.filter((x) => !oldTop.has(x.bvid));
            const removed = old.slice(0, FAV_REFRESH_TOP).filter((x) => !newTop.has(x.bvid));
            console.warn('[bili] 收藏夹每日 6 点刷新（最新 ' + fresh.length + ' 首）：新增 ' + added.length + '，移除 ' + removed.length + '，缓存共 ' + merged.length + ' 首');
            for (const a of added.slice(0, 10)) console.warn('[bili]   + ' + String(a.title || '').slice(0, 40));
            for (const d of removed.slice(0, 10)) console.warn('[bili]   - ' + String(d.title || '').slice(0, 40));
        } catch { /* 日志失败无所谓 */ }
        const packed = { at: Date.now(), folder: r.folder, total: r.total, mid: String(mid || ''), items: merged };
        writeFavCache(packed);
        return packed;
    })();
    favRefreshing = job;
    let packed;
    try {
        packed = await job;
    } catch (e) {
        // B站 挂了/限流：**拿旧的顶着**（心动模式和首页不至于整片空掉）
        if (c && Array.isArray(c.items) && c.items.length) {
            console.warn('[bili] 收藏夹刷新失败（' + e.message + '），先用旧的 ' + c.items.length + ' 首');
            return { folder: c.folder, total: c.total, items: c.items.slice(0, n), cached: true, at: c.at, stale: true };
        }
        throw e;
    } finally {
        favRefreshing = null;
    }
    return { folder: packed.folder, total: packed.total, items: packed.items.slice(0, n), cached: false, at: packed.at };
}

export async function addToFav(bvid, ck) {
    const want = String(bvid || '').trim();
    if (!/^BV[0-9A-Za-z]{10}$/.test(want)) throw new Error('bvid 不合法');
    const { csrf, folderId, folderName } = await favTarget(ck);
    // B站 的收藏接口收的是 **aid**（数字），不是 bvid
    const info = await api('https://api.bilibili.com/x/web-interface/view', { bvid: want });
    const aid = info && info.aid;
    if (!aid) throw new Error('这个视频取不到 aid，没法收藏');
    let j;
    try {
        j = await pubPost('https://api.bilibili.com/x/v3/fav/resource/deal', {
            rid: String(aid),
            type: '2',
            add_media_ids: String(folderId),
            del_media_ids: '',
            csrf,
            platform: 'web',
        });
    } catch (e) {
        // 已经收藏过：B站 会报 11204/11205/11001/20005 之类，对用户来说等于"已收藏" ✓
        const code = Number((String(e.message).match(/拒绝：(-?\d+)/) || [])[1]);
        if ([11204, 11205, 11001, 20005].includes(code)) return { ok: true, fresh: false, folder: folderName };
        throw e;
    }
    return { ok: true, fresh: j.code === 0, folder: folderName };
}

// 纯函数：从一个候选池里挑出最终的 N 首（好测 ✓ 见 check-bili.mjs）
//   · 排除它自己 / 失效的 / **最近刚给你看过的** ✓
//   · 每个 UP 主最多 maxPerAuthor 首（B站 上很多是搬运营，一个号能刷满屏 ✗）
//   · 如果"没见过"的不够，就按最早的顺序把见过的补上（轮换，别让列表空着 ✓）
export function rankCandidates(pool, { exclude = '', limit = 10, maxPerAuthor = 2, recent = new Set() } = {}) {
    const out = [];
    const picked = new Set();
    const perAuthor = new Map();
    const ok = (it) => !!(it && it.bvid && it.bvid !== exclude && !looksDead(it));
    for (const it of pool) {
        if (out.length >= limit) break;
        if (!ok(it) || picked.has(it.bvid) || recent.has(it.bvid)) continue;
        const a = it.author || '?';
        if ((perAuthor.get(a) || 0) >= maxPerAuthor) continue;
        picked.add(it.bvid);
        perAuthor.set(a, (perAuthor.get(a) || 0) + 1);
        out.push(it);
    }
    if (out.length < limit) {
        for (const it of pool) {
            if (out.length >= limit) break;
            if (!ok(it) || picked.has(it.bvid)) continue;
            picked.add(it.bvid);
            out.push(it);
        }
    }
    return out;
}

// 两处（相关推荐 / 个性化流）的条目形状一样，共用一个映射
function mapRelItem(m) {
    return {
        bvid: m.bvid,
        title: String(m.title || '').replace(/<[^>]+>/g, ''),
        author: m.owner?.name || '',
        cover: m.pic
            ? String(m.pic).startsWith('//')
                ? 'https:' + m.pic
                : String(m.pic).replace(/^http:/, 'https:')
            : '',
        duration: Number(m.duration) || 0,
        // 播放量：心动模式要按播放量加权 / 排除大热门（2026/10/17）
        view: Number((m.stat && m.stat.view) || 0) || 0,
        // 分区：30 = VOCALOID·UTAU（心动模式"识别不出P主/歌姬"时的兜底判断 ✓）
        tid: Number(m.tid) || 0,
        tname: String(m.tname || ''),
    };
}
// 用户 2026/10/16：「推荐页（就是什么都没搜索的时候展现的页面）改成随机挑选我的
// 默认收藏夹 20 首推荐吧，每天更新一次」。
//
// 做法：拿**日期当种子**，而不是真随机 ——
//   · 同一天所有人看到同一批 ✓（真随机的话每刷新一次就变，还会反复打 B站）
//   · 第二天自动换 ✓（换个种子就是另一批）
//   · 服务重启也不会变 ✓（同一个日期必然推出同一个结果，不用往库里存东西）
//   · 也**可以测** ✓（纯函数，喂同一个日期必然同一批 —— 见 check-bili.mjs）
// ---------- 每日随机推荐（默认收藏夹）----------
// 用户 2026/10/16：「推荐页改成随机挑选我的默认收藏夹 20 首推荐，每天更新一次」。
// 拿**日期当种子**（不是真随机）：同一天所有人同一批 ✓ 第二天自动换 ✓
// 重启也不变 ✓ 而且纯函数、可以测 ✓
export function prngFor(seedText) {
    // xmur3 小哈希 → mulberry32：够用、快、且完全确定性
    let h = 1779033703 ^ seedText.length;
    for (let i = 0; i < seedText.length; i++) {
        h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 从池子里确定性地抽 limit 首（Fisher–Yates 洗一遍再取前 limit）
export function pickDaily(pool, limit, day) {
    const rnd = prngFor(String(day));
    const arr = pool.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
    }
    return arr.slice(0, Math.max(0, Number(limit) || 0));
}

// 从 totalPages 里确定性地挑 howMany 个不重复页码（1 基，升序）。
// 为什么按"页"挑：收藏夹 4800 首有 120 多页，全抓太重也太慢；
// 随机挑几页凑个池子（每页 40 首）就足够"随机推荐"了。
export function dailyPageNumbers(totalPages, howMany, day) {
    const pages = Math.max(1, Number(totalPages) || 1);
    const rnd = prngFor(String(day) + ':pages');
    const want = Math.max(1, Math.min(Number(howMany) || 1, pages));
    const set = new Set();
    let guard = 0;
    while (set.size < want && guard++ < 1000) set.add(1 + Math.floor(rnd() * pages));
    return [...set].sort((a, b) => a - b);
}