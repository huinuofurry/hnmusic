import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as bili from './bili.js';
import * as store from './store.js';
import * as api from './api.js';
import * as auth from './auth.js';
import * as rooms from './rooms.js';
// 上线时用环境变量控制：PORT 换端口，HOST 挂反代时设成 127.0.0.1（只让本机 Caddy/nginx 连）
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// 导入 B 站收藏夹一次最多抓多少首。
// 注意**不逐首查 cid**（4000 首要 4000 次请求），改成播到那首再补。
const FAV_MAX = 5000;
const FAV_PAGES = 130; // 130 页 × 40 = 5200 首
const FAV_PAGE_SIZE = 40; // 收藏夹接口一页最多 40（ps=41 就 -400，实测）
// 单个歌单上限（PLAYLIST_MAX）和批量上限都来自 track.js，**只定义一份**
import { PLAYLIST_MAX } from './track.js';
// 限制并发地跑一批异步任务（抓上百页不能一次性全发出去，会被风控）
async function mapLimit(list, limit, fn) {
    const out = new Array(list.length).fill(null);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const at = next++;
            if (at >= list.length) return;
            out[at] = await fn(list[at], at);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
    return out;
}
// B 站查询结果的小缓存（进程内）。
// 首页每次加载都要问 B 站三件事（搜人 / 收藏夹列表 / 第一页），
// 不缓存的话刷新几下就可能吃到限流；导入弹窗里翻收藏夹同理。
// 只缓存"查"的部分，导入本身永远走实时请求。
const biliCache = new Map();
// fresh:true = 不理缓存，重新去问上游（拿到新结果照样写回缓存）。
// 只给"管理员点刷新"这种场景用 —— 首页预览默认要缓存，
// 不然每次刷新都去打 B 站，几下就吃限流。
async function cached(key, ttlMs, fn, { fresh = false } = {}) {
    const hit = biliCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < ttlMs) return hit.data;
    try {
        const data = await fn();
        biliCache.set(key, { at: Date.now(), data });
        return data;
    } catch (e) {
        // 以前拿到过就先用旧的顶着：B 站偶尔限流（比如刚导完一个几千首的收藏夹），
        // 首页不该因为上游抖一下就整片空掉
        if (hit) return hit.data;
        throw e;
    }
}
// ---------- 登录限流（上线才需要，2026/10/15 加）----------
// 公开到公网以后，用户名是已知的（就是管理员那个），不挡就是随便爆破。
// 按"来源 IP + 只数失败次数"限流：10 分钟内失败 10 次就拒一会儿。
// 挂反代时要看 X-Forwarded-For（自己人的 Caddy/nginx 才会设它）。
const LOGIN_WINDOW = 10 * 60e3;
const LOGIN_MAX_FAIL = 10;
const loginFails = new Map(); // ip -> {count, firstAt}
function clientIp(req) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || req.socket?.remoteAddress || 'unknown';
}
function loginBlocked(ip) {
    const rec = loginFails.get(ip);
    if (!rec) return 0;
    if (Date.now() - rec.firstAt > LOGIN_WINDOW) {
        loginFails.delete(ip);
        return 0;
    }
    return rec.count >= LOGIN_MAX_FAIL ? Math.ceil((rec.firstAt + LOGIN_WINDOW - Date.now()) / 1000) : 0;
}
function noteLoginFail(ip) {
    const rec = loginFails.get(ip);
    if (!rec || Date.now() - rec.firstAt > LOGIN_WINDOW) loginFails.set(ip, { count: 1, firstAt: Date.now() });
    else rec.count++;
    // 别让这张表无限长
    if (loginFails.size > 5000) loginFails.clear();
}

function json(res, code, obj) {    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch {
                const e = new Error('JSON 不合法');
                e.status = 400;
                reject(e);
            }
        });
        req.on('error', reject);
    });
}
function statusError(status, message) {
    const e = new Error(message);
    e.status = status;
    throw e;
}
// ---- 身份：Bearer 不透明令牌 → 查 sessions 表校验 ----
// 令牌由前端存 localStorage 并用 Authorization 头发，不用 cookie，所以天然没有 CSRF 问题
function bearerToken(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    return m ? m[1].trim() : '';
}
function contextOf(req) {
    const s = auth.getSession(bearerToken(req));
    if (!s) return { token: '', sid: '', userId: null, role: null, user: null };
    const user = s.userId ? auth.findUserById(s.userId) : null;
    // 会话还在但用户被删了 → 当作未登录
    if (s.userId && !user) return { token: '', sid: '', userId: null, role: null, user: null };
    // token 是凭据（只在 Authorization 头里用）；sid 是可以公开的身份标识
    return { token: s.token, sid: s.sid, userId: s.userId, role: user ? user.role : null, user };
}
// 调用者的身份键（和 db.queues 用的是同一套 ✓）
function keyOf(ctx) {
    if (!ctx) return '';
    return ctx.userId ? 'u:' + ctx.userId : ctx.sid ? 's:' + ctx.sid : '';
}
// 这个调用者登录的 B站 cookie（2026/10/17 P1）
// 没登录过 ⇒ undefined ⇒ bili.js 内部回落到全局小号 ✓（首页公开收藏夹之类照旧）
function cookieOf(ctx) {
    const k = keyOf(ctx);
    if (!k) return undefined;
    const db = store.getDb();
    const c = db.biliCookies && db.biliCookies[k];
    return c || undefined;
}
// 存/清这个调用者的 B站 cookie
function setCookieOf(ctx, cookie) {
    const k = keyOf(ctx);
    if (!k) return false;
    const db = store.getDb();
    if (!db.biliCookies) db.biliCookies = {};
    if (cookie) db.biliCookies[k] = String(cookie);
    else delete db.biliCookies[k];
    store.save();
    return !!cookie;
}
function requireAdmin(req) {
    const ctx = contextOf(req);
    if (!ctx.userId) throw statusError(401, '需要登录');
    if (ctx.role !== 'admin') throw statusError(403, '需要管理员权限');
    return ctx;
}
// ---- 流代理：白名单 + 补 Referer + 透传 Range（拖动进度条必需） ----
async function proxy(req, res, target) {
    let u;
    try {
        u = new URL(target);
    } catch {
        return json(res, 400, { error: 'url 不合法' });
    }
    // 白名单 + "B 站 API 亲手给过我们的域名"（见 bili.isProxyAllowed）
    if (!bili.isProxyAllowed(u.hostname)) {
        // ⚠️ 这里拒掉 = 这首歌直接放不出来，而浏览器只会说
        //    "no supported source"，很难联想到是白名单。
        //    所以必须打日志，别再摸黑查（2026/10/15 就摸了一晚上）。
        console.warn('[proxy] 拒绝未登记的域名: ' + u.hostname);
        return json(res, 403, { error: '域名不在白名单: ' + u.hostname });
    }
    const up = await fetch(u, {
        headers: {
            'User-Agent': UA,
            Referer: 'https://www.bilibili.com',
            ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
    });
    const h0 = up.headers.get('content-type') ?? 'application/octet-stream';
    // ⚠️ 封面图也必须依赖浏览器缓存：实测封面平均 225KB/张，一页 20 张 = 4.4MB，
    // 而它们同样是走服务器中转的。设成 no-store 的话，每打开一次列表/刷新一次首页
    // 就要从服务器重下 4.4MB —— 比听歌本身还费流量（听歌才 64MB/小时）。
    // B 站的封面 URL 是唯一的、内容不变，所以可以放心长缓存。
    //
    // 音频原来是 no-store ✗ —— 2026/10/16 用户要求"一起听预热下一首"时才发现：
    // 浏览器一个字都不缓存 ⇒ 预热**完全白下**（真播时还要重下一遍，带宽翻倍）✗
    // 改成私有长缓存：URL 里带着 deadline+签名，本身就是内容指纹，
    // 同一个 URL 的字节永远一样；而签名一换就是**新 URL**（自然 cache miss），
    // 所以缓存不会张冠李戴 ✓ 用 private（不进任何共享缓存）✓
    // 副作用是好的：同一首歌重播/来回切不再回回都从服务器拉 ✓
    const isImg = /^image\//.test(h0);
    // ⚠️ iOS Safari 对 `application/octet-stream` 的 <audio> 直接报
    //    "The operation is not supported." ✗（2026/10/19 用户手机上实测）
    //    B站 音频是 m4s（fMP4/AAC）⇒ 明确告诉浏览器是 audio/mp4 ✓
    //    （桌面 Chrome 靠内容嗅探能播，所以之前一直没暴露 ✗）
    let hType = h0;
    if (!isImg && /octet-stream/i.test(h0)) hType = 'audio/mp4';
    const h = {
        'Content-Type': hType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': isImg ? 'public, max-age=604800, immutable' : 'private, max-age=21600, immutable',
        // 媒体请求默认不进 Resource Timing（浏览器看不到就不给，除非资源方允许）——
        // 加上这个之后，"预热的那一首到底有没有命中缓存"这类问题**能直接量**：
        // performance.getEntriesByName(url) 里 transferSize=0 就是走了缓存 ✓
        // （2026/10/16 想验证预热效果时，就是因为缺这个头量不出来）
        'Timing-Allow-Origin': '*',
    };
    for (const k of ['content-length', 'content-range']) {
        const v = up.headers.get(k);
        if (v) h[k.replace(/(^|-)(\w)/g, (_, a, b) => a + b.toUpperCase())] = v;
    }
    res.writeHead(up.status, h);
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).pipe(res);
}
store.load();
// 2026/10/17 P1 迁移：全局文件里那份 B站 cookie 属于管理员 ⇒ 迁到管理员名下 ✓
// （否则改成"每用户隔离"后，管理员个人中心会显示"未绑定" ✗）
// 用户自己的状态/收藏夹**绝不**再回落到全局（见 cookieOf 的用法）✓
try {
    const _db = store.getDb();
    if (!_db.biliCookies) _db.biliCookies = {};
    if (!Object.keys(_db.biliCookies).length && bili.cookieState().on) {
        const _admin = (_db.users || []).find((u) => u.role === 'admin');
        const _ck = bili.exportGlobalCookie ? bili.exportGlobalCookie() : '';
        if (_admin && _ck) {
            _db.biliCookies['u:' + _admin.id] = _ck;
            store.save();
            console.warn('[bili] 已把全局小号迁移到管理员 ' + _admin.username + ' 名下');
        }
    }
} catch (e) {
    console.warn('[bili] 迁移全局小号失败：' + e.message);
}
auth.pruneSessions(); // 启动时清掉过期令牌，避免 sessions 无限增长
auth.pruneInvites();  // 顺手清掉"用过但还留着"的邀请码（现在用掉就删，这是老数据的清理）
// 房间**恢复**（不是清掉）：部署/升级后还能回到原来的房间和收听位置
// （用户 2026/10/16：「希望上线的时候也能保留上次听到的队列的位置」）
const restoredRooms = rooms.restoreAll();
if (restoredRooms) console.log('[rooms] 恢复了 ' + restoredRooms + ' 个房间（暂停在原位置，等大家回来）');
api.pruneQueues();    // 顺手清掉没有对应会话的游客队列
rooms.startTickers(); // 空房回收 + "歌放完了服务端自己切下一首"
store.save();

// 定期清理游客数据（用户 2026/10/16："加一个定期清理游客账号数据"，
// 并明确"每小时跑一轮改成每天跑一轮"、"所有游客都 7 天没上线清"）
// 原来只在**启动时**清一次 ✗ —— 服务器一跑好几天，游客身份就一直堆着
// （实测上线一天就 67 个，绝大多数是"路过看一眼"留下的空队列）。
// 每天跑一遍：过期会话 + 闲置 7 天的游客（不分有没有歌）+ 孤儿队列。
const PRUNE_EVERY = Number(process.env.HN_PRUNE_EVERY) || 24 * 3600e3;
setInterval(() => {
    try {
        // ⚠️ pruneQueues() 会返回条数（以前不返回 → 加起来是 NaN → if (n) 永远假
        //    ⇒ 清了但不落盘 ✗ 2026/10/16 自己 review 抓到的）
        const n = auth.pruneSessions() + api.pruneQueues();
        if (n > 0) {
            store.save();
            console.log('[prune] 清掉 ' + n + ' 条过期/闲置的会话或队列');
        }
    } catch (e) {
        console.warn('[prune] 出错：' + e.message);
    }
}, PRUNE_EVERY).unref(); // unref：别让它拖住进程退出
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    const m = req.method;
    try {
        if (p === '/api/search') {
            const q = url.searchParams.get('q') || '';
            return json(res, 200, { items: await bili.search(q) });
        }
        if (p === '/api/resolve') {
            return json(res, 200, await bili.resolve(url.searchParams.get('bvid')));
        }
        if (p === '/api/audio-debug') {
            return json(res, 200, await bili.audioDebug(
                url.searchParams.get('bvid'),
                url.searchParams.get('cid')
            ));
        }
        if (p === '/api/audio') {
            const bvid = url.searchParams.get('bvid');
            // cid 和 up 主名都允许缺省：导入的歌单条目不带 cid，播到这首才补一次。
            // bili.infoOf 用**同一次 /view 请求**把 cid 和 up 主名一起拿回来（带缓存），
            // 前端已经知道的会通过 author 参数带过来 —— 都知道了就一次 B 站请求都不打。
            const givenCid = url.searchParams.get('cid');
            const givenAuthor = url.searchParams.get('author');
            const info = await bili.infoOf(bvid, givenCid, givenAuthor);
            // 惰性补到的立刻回写进歌单和队列：同一首歌一辈子只查这一次
            if (!givenCid || !givenAuthor) api.backfillTrack(bvid, info);
            // fresh=1：绕开取流地址缓存。前端在音频加载失败（地址过期）时会带它重试
            const fresh = url.searchParams.get('fresh') === '1';
            const a = await bili.getAudio(bvid, info.cid, { fresh });
            return json(res, 200, {
                src: '/proxy?url=' + encodeURIComponent(a.url),
                quality: a.quality,
                bandwidth: a.bandwidth,
                cid: info.cid,
                author: info.author,
            });
        }
        if (p === '/proxy') {
            await proxy(req, res, url.searchParams.get('url'));
            return;
        }

        // ---- 账户（M3）----
        if (p === '/api/auth/guest' && m === 'POST') {
            const s = auth.createSession(null); // 游客：不建 user 记录，userId = null
            store.save();
            return json(res, 200, { user: null, token: s.token, expiresAt: s.expiresAt });
        }
        if (p === '/api/auth/register' && m === 'POST') {
            const c = contextOf(req);
            const r = auth.register(await readBody(req));
            api.adoptGuestQueue(c.userId ? '' : c.token, r.user.id); // 游客先攒的队列过继给新账号
            store.save();
            return json(res, 200, r);
        }
        // 健康检查：反代/systemd/探针用，不需要身份也不碰库
        if (p === '/api/health') {
            return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
        }
        if (p === '/api/auth/login' && m === 'POST') {
            const ip = clientIp(req);
            const blockFor = loginBlocked(ip);
            if (blockFor) {
                res.setHeader('Retry-After', String(blockFor));
                return json(res, 429, { error: '失败次数太多了，' + Math.ceil(blockFor / 60) + ' 分钟后再试' });
            }
            const c = contextOf(req);
            let r;
            try {
                r = auth.login(await readBody(req));
            } catch (e) {
                if (e?.status === 401) noteLoginFail(ip); // 密码错才算失败，别的错（参数不全等）不算
                throw e;
            }
            loginFails.delete(ip);
            api.adoptGuestQueue(c.userId ? '' : c.token, r.user.id);
            store.save();
            return json(res, 200, r);
        }
        if (p === '/api/auth/logout' && m === 'POST') {
            const c = contextOf(req);
            if (c.token) auth.deleteSession(c.token);
            store.save();
            return json(res, 200, { ok: true });
        }
        if (p === '/api/auth/me' && m === 'GET') {
            const c = contextOf(req);
            return json(res, 200, {
                user: auth.publicUser(c.user),
                role: c.role,
                // 前端靠这个区分"游客身份有效"和"令牌已失效"，失效就自动重新拿游客令牌
                session: c.token ? (c.userId ? 'user' : 'guest') : null,
            });
        }
        // 改昵称（不是改账号）
        if (p === '/api/auth/profile' && m === 'PATCH') {
            const c = contextOf(req);
            if (!c.userId) throw statusError(401, '需要登录');
            const body = await readBody(req);
            const u = auth.changeDisplayName(c.userId, body.displayName);
            rooms.refreshNames(c.userId); // 房间里的成员名字要立刻跟着变
            store.save();
            return json(res, 200, { user: auth.publicUser(u) });
        }
        // 改密码：清掉该用户所有旧令牌，再给当前这个客户端补一张新的
        // （旧令牌全失效，但当前设备不用重新登录）
        if (p === '/api/auth/password' && m === 'POST') {
            const c = contextOf(req);
            if (!c.userId) throw statusError(401, '需要登录');
            const body = await readBody(req);
            const r = auth.changePassword(c.userId, body.newPassword);
            const fresh = auth.createSession(c.userId);
            store.save();
            return json(res, 200, {
                ok: true,
                killedSessions: r.killedSessions,
                token: fresh.token,
                expiresAt: fresh.expiresAt,
            });
        }

        // ---- 管理端：发 / 看 / 吊销邀请码（仅管理员）----
        if (p === '/api/admin/invites' && m === 'GET') {
            requireAdmin(req);
            return json(res, 200, { invites: auth.listInvites() });
        }
        if (p === '/api/admin/invites' && m === 'POST') {
            const admin = requireAdmin(req);
            const body = await readBody(req);
            const inv = auth.createInvite({
                createdBy: admin.userId,
                expiresInDays: body.expiresInDays ?? null,
            });
            store.save();
            return json(res, 200, inv);
        }
        let mm;
        mm = p.match(/^\/api\/admin\/invites\/([^/]+)$/);
        if (mm && m === 'DELETE') {
            requireAdmin(req);
            const inv = auth.revokeInvite(decodeURIComponent(mm[1]));
            store.save();
            return json(res, 200, inv);
        }

        // 当前请求的身份（游客也有一份，只是 userId = null）
        const ctx = contextOf(req);

        if (p === '/api/state' && m === 'GET') return json(res, 200, api.list(ctx));
        // 队列：每人一份，所以必须有身份（游客也要先拿令牌）才能读写
        if (p === '/api/queue' && m === 'GET') return json(res, 200, api.getQueue(ctx));
        if (p === '/api/playlists' && m === 'POST') {
            return json(res, 200, api.createPlaylist(await readBody(req), ctx));
        }

        mm = p.match(/^\/api\/playlists\/([^/]+)$/);
        if (mm) {
            const id = decodeURIComponent(mm[1]);
            if (m === 'GET') return json(res, 200, api.getPlaylist(id, ctx));
            if (m === 'PATCH') return json(res, 200, api.renamePlaylist(id, await readBody(req), ctx));
            if (m === 'DELETE') return json(res, 200, api.deletePlaylist(id, ctx));
        }
        mm = p.match(/^\/api\/playlists\/([^/]+)\/items\/([^/]+)$/);
        if (mm && m === 'DELETE') {
            return json(res, 200, api.removeFromPlaylist(decodeURIComponent(mm[1]), decodeURIComponent(mm[2]), ctx));
        }
        mm = p.match(/^\/api\/playlists\/([^/]+)\/items$/);
        if (mm && m === 'POST') {
            return json(res, 200, api.addToPlaylist(decodeURIComponent(mm[1]), await readBody(req), ctx));
        }
        mm = p.match(/^\/api\/playlists\/([^/]+)\/move$/);
        if (mm && m === 'POST') {
            return json(res, 200, api.moveInPlaylist(decodeURIComponent(mm[1]), await readBody(req), ctx));
        }
        mm = p.match(/^\/api\/playlists\/([^/]+)\/play$/);
        if (mm && m === 'POST') {
            return json(res, 200, api.playPlaylist(decodeURIComponent(mm[1]), ctx));
        }

        if (p === '/api/queue/items' && m === 'POST') {
            return json(res, 200, api.queueAdd(await readBody(req), ctx));
        }
        mm = p.match(/^\/api\/queue\/items\/([^/]+)$/);
        if (mm && m === 'DELETE') {
            return json(res, 200, api.queueRemove(decodeURIComponent(mm[1]), ctx));
        }
        if (p === '/api/queue/move' && m === 'POST') {
            return json(res, 200, api.queueMove(await readBody(req), ctx));
        }
        if (p === '/api/queue/clear' && m === 'POST') {
            return json(res, 200, api.queueClear(ctx));
        }
        if (p === '/api/queue/current' && m === 'POST') {
            const body = await readBody(req);
            return json(res, 200, api.queueCurrent(body.itemId, ctx));
        }
        if (p === '/api/queue/advance' && m === 'POST') {
            return json(res, 200, api.queueAdvance(await readBody(req), ctx));
        }
        if (p === '/api/queue/mode' && m === 'POST') {
            return json(res, 200, api.queueMode(await readBody(req), ctx));
        }

        // ---- B 站收藏夹导入（2026/10/15）----
        // 查用户和收藏夹都是**匿名**的（B 站游客就能看别人的公开收藏夹）；
        // 只有"导进来"这一步要登录，因为歌单得有个主人。
        if (p === '/api/bili/user' && m === 'GET') {
            const q = (url.searchParams.get('q') || '').trim();
            if (!q) return json(res, 400, { error: '缺少 q' });
            return json(res, 200, { users: await cached('u:' + q, 10 * 60e3, () => bili.searchUser(q)) });
        }
        // P5：某个收藏夹里的条目（挑歌界面用；带调用者自己的 cookie ⇒ 私密夹也能读 ✓）
        // 批量查 P主（心动模式加权用 ✓ 2026/10/17）
        if (p === '/api/bili/creators' && m === 'GET') {
            const bvids = String(new URL(req.url, 'http://localhost').searchParams.get('bvids') || '').split(',').filter(Boolean).slice(0, 12);
            const r = await bili.creatorsOf(bvids);
            return json(res, 200, { creators: r });
        }
        // 2026/10/19：不像歌名的候选 ⇒ 扒简介看它是不是歌（限流时一律返回 false ⇒ 前端跳过）
        if (p === '/api/bili/songcheck' && m === 'GET') {
            const bvids = String(new URL(req.url, 'http://localhost').searchParams.get('bvids') || '').split(',').filter(Boolean).slice(0, 12);
            const r = await bili.songcheckOf(bvids);
            return json(res, 200, { songs: r, blocked: bili.biliBlockedFor() });
        }
        if (p === '/api/bili/fav-items' && m === 'GET') {
            const ctx = contextOf(req);
            const mediaId = String(url.searchParams.get('mediaId') || '').trim();
            const pn = Math.max(1, Math.min(Number(url.searchParams.get('pn')) || 1, 60));
            if (!mediaId) return json(res, 400, { error: '缺少 mediaId' });
            try {
                const pg = await bili.listFavItems(mediaId, pn, 40, cookieOf(ctx));
                return json(res, 200, { pn, count: pg.count || 0, title: pg.title || '', items: pg.items || [] });
            } catch (e) {
                return json(res, 502, { error: e.message });
            }
        }

        // P5：把**选中的**若干首导入到歌单（不传 playlistId ⇒ 新建，名字默认收藏夹名 ✓）
        if (p === '/api/playlists/import-tracks' && m === 'POST') {
            const ctxI = contextOf(req);
            if (!ctxI.userId) return json(res, 401, { error: '需要登录后才能保存歌单' });
            const bodyI = await readBody(req);
            const tracks = Array.isArray(bodyI.tracks) ? bodyI.tracks.slice(0, 2000) : [];
            if (!tracks.length) return json(res, 400, { error: '没有选中的曲子' });
            const clean = tracks
                .map((x) => ({
                    bvid: String((x && x.bvid) || '').trim(),
                    cid: x && x.cid != null ? String(x.cid) : '',
                    title: String((x && x.title) || '').slice(0, 300),
                    author: String((x && x.author) || '').slice(0, 120),
                    cover: String((x && x.cover) || ''),
                    duration: Number(x && x.duration) || 0,
                }))
                .filter((x) => /^BV[0-9A-Za-z]{10}$/.test(x.bvid));
            if (!clean.length) return json(res, 400, { error: '选中的曲目都不合法' });
            try {
                const plId = String(bodyI.playlistId || '').trim();
                if (!plId) {
                    const name = String(bodyI.name || '').trim().slice(0, 80) || '导入的歌单';
                    const made = api.importPlaylist({ name, items: clean }, ctxI);
                    return json(res, 200, { ok: true, playlistId: made.id, count: made.count, created: true });
                }
                let added = 0;
                for (const it of clean) {
                    try { api.addToPlaylist(plId, it, ctxI); added++; } catch { /* 跳过重复/失效 */ }
                }
                return json(res, 200, { ok: true, playlistId: plId, count: added, created: false });
            } catch (e) {
                return json(res, 400, { error: e.message });
            }
        }

        // P3：**我自己**的收藏夹（含私密 ✓ 用调用者自己的 cookie 读）
        if (p === '/api/bili/my-favs' && m === 'GET') {
            const ctx = contextOf(req);
            const ck = cookieOf(ctx);
            if (!ck) return json(res, 409, { error: '还没绑定 B站 账号' });
            const mid = (String(ck).match(/DedeUserID=(\d+)/) || [])[1];
            if (!mid) return json(res, 409, { error: 'cookie 里没有 DedeUserID，重新扫码登录一次' });
            try {
                return json(res, 200, { mid, folders: await bili.listFavFolders(mid, ck) });
            } catch (e) {
                return json(res, 502, { error: e.message });
            }
        }

        if (p === '/api/bili/favs' && m === 'GET') {
            const mid = (url.searchParams.get('mid') || '').trim();
            if (!mid) return json(res, 400, { error: '缺少 mid' });
            return json(res, 200, { folders: await cached('f:' + mid, 10 * 60e3, () => bili.listFavFolders(mid)) });
        }
        // 首页默认内容：某个用户的**默认收藏夹**前 N 首。
        // 一次请求把"搜人 → 找默认收藏夹 → 取第一页"全做完，前端不用串三次。
        // 缓存 5 分钟：首页每次刷新都去打 B 站的话，几下就吃限流了
        // 当前播放曲目的"相关推荐"（左栏那一栏用，用户 2026/10/16 要求）
        if (p === '/api/bili/related' && m === 'GET') {
            const bvid = (url.searchParams.get('bvid') || '').trim();
            const limit = Math.min(Number(url.searchParams.get('limit')) || 10, 20);
            if (!bvid) return json(res, 400, { error: '缺少 bvid' });
            // ⚠️ 这里**不能**再套一层 cached() ✗ ——
            //    "每次换一批"（去重轮换）是在 bili.related() 里算的，
            //    整份缓存 20 分钟会把轮换吃掉（2026/10/17 线上实测过 ✗）。
            //    上游的原始列表在 bili.js 里按 bvid 缓存 20 分钟 ✓ 配额一样省
            const data = await bili.related(bvid, limit);
            return json(res, 200, data);
        }

        // 客户端日志回收（2026/10/17）—— 用户排查播放问题时，浏览器控制台的东西
        // 我这边看不到（我连不上他的浏览器）。所以让页面把**关键几行**发上来：
        // 只收 warn/error 级别的、每页最多 30 条、单个请求最多 2KB ⇒ 不会被刷爆 ✓
        // 落到 journal 里，`journalctl -u hnmusic | grep '\[client\]'` 就能看 ✓
        if (p === '/api/client-log' && m === 'POST') {
            const body = await readBody(req).catch(() => null);
            const lines = body && Array.isArray(body.lines) ? body.lines.slice(0, 30) : [];
            const ua = String(req.headers['user-agent'] || '').slice(0, 80);
            for (const l of lines) {
                console.warn('[client] ' + String(l).slice(0, 500));
            }
            console.warn('[client] --- end of batch (' + lines.length + ' lines, ua=' + ua + ')');
            return json(res, 200, { ok: true, got: lines.length });
        }

        // 首页"为你推荐"：某个 B站 用户**公开收藏夹**的前几首
        //（2026/10/17 用户要求：显示他大号「灰诺-」默认收藏夹的前几首 ✓ 公开数据 ✓）
        // 缓存 10 分钟 —— 收藏夹不常变，别每次开首页都打一次 B站 ✓
        if (p === '/api/bili/fav-folder' && m === 'GET') {
            const q = url.searchParams;
            const mid = String(q.get('mid') || process.env.HN_FAV_MID || '17800413');
            const limit = String(q.get('limit') || '6');
            // 用**落盘缓存**：每天 6 点（上海时间）**只刷新最新 15 首**，其余保持不动
            //（2026/10/19 用户要求；见 bili.favFolderCached 的注释）
            // fresh=1 ⇒ 立刻刷一次（**只有管理员**；跟 fav-preview 的 fresh 一个规矩）
            const wantFresh = q.get('fresh') === '1';
            const ctxF = contextOf(req);
            if (wantFresh && !(ctxF && ctxF.role === 'admin')) {
                return json(res, 403, { error: '只有管理员能强制刷新收藏夹' });
            }
            return json(res, 200, await bili.favFolderCached(mid, Number(limit), cookieOf(ctx), { force: wantFresh }));
        }

        // 小号凭据状态（个人中心显示"已登录：某某"）—— 只给管理员，不返回 cookie 内容
        if (p === '/api/admin/bili-status' && m === 'GET') {
            const ctx = contextOf(req);
            if (!ctx.userId) return json(res, 401, { error: '需要登录' });
            // P2：任何已登录用户都能查**自己**的 B站 绑定状态 ✓
            // ⚠️ 这里**必须**用 cookieOf(ctx) || ''：
            //    undefined 在 bili.js 里表示"回落到全局小号"，会让所有人都看到管理员绑的号 ✗
            const ownCk = cookieOf(ctx) || '';
            const st = bili.cookieState(ownCk);
            const who = st.on ? await bili.whoAmI(ownCk).catch(() => null) : null;
            return json(res, 200, { ...st, uname: who && who.uname, mid: who && who.mid, valid: !!who });
        }

        // 取单条视频的 B站 标签（管理员；给 classify-fav-tags 走服务器出口用）。
        // 一首一次请求，所以**别拿它跑量**：只在"可疑项"那几十上百条上用。
        if (p === '/api/admin/fav-tags' && m === 'GET') {
            const ctx = contextOf(req);
            if (!ctx.userId) return json(res, 401, { error: '需要登录' });
            if (ctx.role !== 'admin') return json(res, 403, { error: '需要管理员权限' });
            const bv = String(url.searchParams.get('bvid') || '').trim();
            if (!/^BV[0-9A-Za-z]{8,12}$/.test(bv)) return json(res, 400, { error: 'bvid 不合法' });
            try {
                return json(res, 200, { bvid: bv, tags: await bili.tagsOf(bv) });
            } catch (e) {
                return json(res, 502, { error: e.message });
            }
        }

        // 重新读一遍"收藏夹分区表"（`data/fav-tids.json`，由
        // scripts/classify-fav-partitions.mjs 在本机慢慢打标签后推上来）。
        // 不加这个口子的话，推完新表得重启服务才生效 —— 而重启会踢人（2026/10/19）。
        if (p === '/api/admin/reload-fav-tids' && m === 'POST') {
            const ctx = contextOf(req);
            if (!ctx.userId) return json(res, 401, { error: '需要登录' });
            if (ctx.role !== 'admin') return json(res, 403, { error: '需要管理员权限' });
            // 分区表和标签表一起重读（两个文件，一个口子；2026/10/19）
            bili.reloadFavTids();
            return json(res, 200, { ok: true });
        }
        // P主 白名单：从收藏夹统计重建（≥2 次算"已知 P主"）2026/10/19 用户定的 B 方案
        if (p === '/api/admin/reload-fav-creators' && m === 'POST') {
            const ctx = contextOf(req);
            if (!ctx.userId) return json(res, 401, { error: '需要登录' });
            if (ctx.role !== 'admin') return json(res, 403, { error: '需要管理员权限' });
            const r = bili.buildCreatorStats();
            return json(res, 200, { ok: true, ...r });
        }

        // 扫码登录小号（管理员，2026/10/17）：入口在「个人中心」
        // start → 返回二维码（data URL）+ qrcode_key；poll → 轮询扫码状态
        if (p === '/api/admin/bili-login/start' && m === 'POST') {
            const ctx = contextOf(req);
            if (!ctx.userId) return json(res, 401, { error: '需要登录' });
            // P2：任何已登录用户都能登录自己的 B站 账号（导入自己收藏夹用）✓

            try {
                return json(res, 200, await bili.startQrLogin());
            } catch (e) {
                return json(res, 502, { error: e.message });
            }
        }
        if (p === '/api/admin/bili-login/poll' && m === 'POST') {
            const ctx = contextOf(req);
            if (!ctx.userId) return json(res, 401, { error: '需要登录' });
            // P2：任何已登录用户都能登录自己的 B站 账号（导入自己收藏夹用）✓

            const body = await readBody(req);
            try {
                const ctx2 = contextOf(req);
                // ⚠️ 必须传 ''（不是 undefined）：undefined 会让 bili.js 去写**全局小号** ✗
                //    传 '' = "这个调用者没有 cookie" ⇒ 只存到调用者名下 ✓ 不覆盖管理员的小号 ✓
                const r = await bili.pollQrLogin(body.qrcode_key, cookieOf(ctx2) || '');
            // 登录成功 ⇒ 把 cookie 存到这个用户/游客名下 ✓（不写全局文件 ✗）
            if (r && r.state === 'ok' && r.cookie) {
                setCookieOf(ctx, r.cookie);
                delete r.cookie; // 绝不下发到浏览器 ✓
                console.warn('[bili] ' + keyOf(ctx) + ' 扫码登录成功：' + (r.uname || '(未知)') + ' 已存到该用户名下');
            }
            return json(res, 200, r);
            } catch (e) {
                return json(res, 502, { error: e.message });
            }
        }

        // P2：解除绑定（只清**自己**的 B站 cookie ✓）
        if (p === '/api/bili/me-logout' && m === 'POST') {
            const ctx = contextOf(req);
            if (!ctx.userId) return json(res, 401, { error: '需要登录' });
            setCookieOf(ctx, '');
            return json(res, 200, { ok: true });
        }

        // 收藏到小号的 B站 收藏夹（管理员专用，2026/10/17 用户要求：
        // "加一个收藏歌曲的按钮…只有我能看到，这样我平时没事往那个账号里面收藏夹
        //  塞点曲子，推流就会好了"）。写操作 ⇒ 只手动点，频率极低 ✓
        if (p === '/api/bili/fav' && m === 'POST') {
            const ctx = contextOf(req);
            if (!ctx.userId) return json(res, 401, { error: '需要登录' });
            if (ctx.role !== 'admin') return json(res, 403, { error: '只有管理员能用这个' });
            const ckFav = cookieOf(ctx);
            if (!bili.personalizedOn(ckFav)) return json(res, 409, { error: '还没登录 B站 账号（个人中心里扫码登录）' });
            const body = await readBody(req);
            try {
                return json(res, 200, await bili.addToFav(body.bvid, ckFav));
            } catch (e) {
                return json(res, 502, { error: e.message });
            }
        }

        // 首页一次性取两批数据（2026/10/19 用户要求）：
        //   cards = 收藏夹**最新**的前 N 首（第一页就是最新的一批，卡片展示用）
        //   items = 每日精选（每天换一批，按上海日期当种子）
        // 为什么要合：以前首页要"卡片一批 + 列表一批"两份数据，分两次请求会闪烁，
        // 而且收藏夹一加歌就可能把"当天那一批"挤掉。合成一个接口后两批数据同源同时刻。
        // fresh=1 只有管理员能用（绕一次就是三次 B站 请求，不能放开）。
        if (p === '/api/home' && m === 'GET') {
            const who = (url.searchParams.get('user') || '').trim();
            if (!who) return json(res, 400, { error: '缺少 user' });
            const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50);
            const cardsN = Math.min(Number(url.searchParams.get('cards')) || 6, 12);
            const wantFresh = url.searchParams.get('fresh') === '1';
            const ctxHome = contextOf(req);
            if (wantFresh && !(ctxHome && ctxHome.role === 'admin')) {
                return json(res, 403, { error: '只有管理员能强制刷新收藏夹' });
            }
            const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
            const data = await cached('home:' + who + ':' + limit + ':' + cardsN + ':' + day, 30 * 60e3, async () => {
                const users = await bili.searchUser(who);
                if (!users.length) throw statusError(404, '没找到 B 站用户「' + who + '」');
                const u = users.find((x) => x.name === who) || users[0];
                const folders = await bili.listFavFolders(u.mid);
                const def = bili.defaultFavFolder(folders);
                if (!def) throw statusError(404, '「' + u.name + '」没有公开的收藏夹');
                // 第一页：既给卡片（最新收藏），也当每日精选的候选池之一
                const first = await bili.listFavItems(def.mediaId, 1);
                const firstItems = first.items || [];
                const totalPages = Math.max(1, Math.ceil((def.count || firstItems.length || 40) / 40));
                const want = Math.min(4, totalPages);
                const pageNos = bili.dailyPageNumbers(totalPages, want, day);
                const pages = await Promise.all(pageNos.map((pn) => (pn === 1 ? { items: firstItems } : bili.listFavItems(def.mediaId, pn))));
                const pool = [];
                const seen = new Set();
                for (const pg of pages) {
                    for (const it of (pg && pg.items) || []) {
                        const k = it.bvid + ':' + (it.cid || '');
                        if (seen.has(k)) continue;
                        seen.add(k);
                        pool.push(it);
                    }
                }
                return {
                    user: { mid: u.mid, name: u.name, avatar: u.avatar },
                    folder: { mediaId: def.mediaId, title: def.title, count: def.count },
                    cards: firstItems.slice(0, cardsN),
                    items: bili.pickDaily(pool, limit, day),
                    daily: day,
                };
            }, { fresh: wantFresh });
            return json(res, 200, data);
        }
        if (p === '/api/bili/fav-preview' && m === 'GET') {
            const who = (url.searchParams.get('user') || '').trim();
            const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50);
            if (!who) return json(res, 400, { error: '缺少 user' });
            // 绕过缓存重新抓（**只有管理员**）：首页那行「刷新收藏夹」按钮就是它。
            // 不给别人绕 —— 每绕一次要打 B 站三次（搜人 + 收藏夹列表 + 第一页），
            // 放开等于把限流风险交给所有人。
            const wantFresh = url.searchParams.get('fresh') === '1';
            const ctx = contextOf(req);
            if (wantFresh && !(ctx && ctx.role === 'admin')) {
                return json(res, 403, { error: '只有管理员能强制刷新收藏夹' });
            }
            // 每天换一批随机推荐（用户 2026/10/16 要求）：
            // 用**上海日期**当种子（"每天"要按用户那边的日历算，不是 UTC），
            // 随机挑几页凑个池子，再从池子里随机取 limit 首。
            // 缓存 key 里带上日期 ⇒ 过了零点自然换新的一批，不用等缓存过期。
            const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
            const data = await cached('pv:' + who + ':' + limit + ':' + day, 30 * 60e3, async () => {
                const users = await bili.searchUser(who);
                if (!users.length) throw statusError(404, '没找到 B 站用户「' + who + '」');
                const u = users.find((x) => x.name === who) || users[0];
                const folders = await bili.listFavFolders(u.mid);
                const def = bili.defaultFavFolder(folders);
                if (!def) throw statusError(404, '「' + u.name + '」没有公开的收藏夹');
                // B 站收藏夹一页 40 首（ps=41 会 -400，实测）
                const totalPages = Math.max(1, Math.ceil((def.count || 40) / 40));
                // 挑几页（大收藏夹挑 4 页 ≈ 160 首的池子，够随机了；小收藏夹就全抓）
                const want = Math.min(4, totalPages);
                const pageNos = bili.dailyPageNumbers(totalPages, want, day);
                const pages = await Promise.all(pageNos.map((pn) => bili.listFavItems(def.mediaId, pn)));
                const pool = [];
                const seen = new Set();
                for (const pg of pages) {
                    for (const it of pg.items) {
                        const k = it.bvid + ':' + (it.cid || '');
                        if (seen.has(k)) continue;
                        seen.add(k);
                        pool.push(it);
                    }
                }
                return {
                    user: { mid: u.mid, name: u.name, avatar: u.avatar },
                    folder: { mediaId: def.mediaId, title: def.title, count: def.count },
                    // 池子太小（收藏夹本身就没几首）时，抽不满就有多少给多少
                    items: bili.pickDaily(pool, limit, day),
                    daily: day,
                };
            }, { fresh: wantFresh });
            return json(res, 200, data);
        }
        if (p === '/api/playlists/import-fav' && m === 'POST') {
            const imp = contextOf(req);
            if (!imp.userId) return json(res, 401, { error: '需要登录后才能保存歌单' });
            const body = await readBody(req);
            const mediaId = String(body.mediaId ?? '').trim();
            if (!mediaId) return json(res, 400, { error: '缺少 mediaId' });
            // 第一页拿到总数，然后**并行**把剩下的页拉回来（4000 首 = 200 页，
            // 串行要三十多秒，并发 5 路大概几秒）
            const impCk = cookieOf(imp);
            const first = await bili.listFavItems(mediaId, 1, 40, impCk);
            const total = first.count || first.items.length;
            if (!total) return json(res, 400, { error: '这个收藏夹里没有能播的视频' });
            const base = first.title || String(body.name ?? '').trim() || '导入的歌单';
            // 超过单个歌单上限：**先问过用户**同意分割才继续（前端会弹确认）
            if (total > PLAYLIST_MAX && body.split !== true) {
                return json(res, 409, {
                    error: '这个收藏夹有 ' + total + ' 首，超过单个歌单 ' + PLAYLIST_MAX + ' 首的上限',
                    needSplit: true,
                    total,
                    parts: Math.ceil(total / PLAYLIST_MAX),
                });
            }
            const wantPages = Math.min(Math.ceil(total / FAV_PAGE_SIZE), FAV_PAGES);
            const all = first.items.slice();
            const failedPages = [];
            if (wantPages > 1) {
                const rest = [];
                for (let pn = 2; pn <= wantPages; pn++) rest.push(pn);
                // ⚠️ 拉 200 多页会被 B 站风控（返回一张 HTML 错误页，不是 JSON）。
                // 所以：并发压到 3、失败重试 3 次（退避）、还失败就**记下来报给用户**，
                // 绝不静默吞掉 —— 之前就是因为静默吞掉，4843 首的收藏夹悄悄只导进 4784 首
                // 2026/10/19 用户："导入歌单时限速可以做" ⇒ 并发 3 → **2**，每页再停 120ms
                // （加上全局令牌桶 160ms/次 ⇒ 约 7 页/秒）。大收藏夹多等十来秒，
                // 换来的是**不把服务器 IP 打进 412**（导一份 4800 首的收藏夹 ≈ 120 页）
                await mapLimit(rest, 2, async (pn) => {
                    await new Promise((r) => setTimeout(r, 120));
                    for (let attempt = 0; attempt < 4; attempt++) {
                        try {
                            const pg = await bili.listFavItems(mediaId, pn, 40, impCk);
                            all.push(...pg.items);
                            return;
                        } catch (e) {
                            // 被限流（412/返回 HTML）时要等久一点再试，普通错误短退避就行
                            const ms = e?.biliCode === 'non-json' ? 3000 * (attempt + 1) : 250 * (attempt + 1);
                            await new Promise((r) => setTimeout(r, ms));
                        }
                    }
                    failedPages.push(pn);
                });
            }
            const capped = all.slice(0, FAV_MAX);
            if (!capped.length) return json(res, 400, { error: '这个收藏夹里没有能播的视频' });
            // 按 1000 一切，切成几个歌单（名字带 (1/5) 后缀）
            const chunks = [];
            for (let i = 0; i < capped.length; i += PLAYLIST_MAX) chunks.push(capped.slice(i, i + PLAYLIST_MAX));
            const made = [];
            for (let i = 0; i < chunks.length; i++) {
                const name = chunks.length > 1 ? base + '（' + (i + 1) + '/' + chunks.length + '）' : base;
                made.push(api.importPlaylist({ name, items: chunks[i] }, imp));
            }
            return json(res, 200, {
                playlists: made,
                count: made.reduce((a, b) => a + b.count, 0),
                total,
                fetched: all.length, // 实际拉到的原始条目数（和 count 的差 = 去重/失效被跳过）
                // "没导全"的三种原因：有页没拉到 / 页数被上限截了 / 条目被 FAV_MAX 截了
                truncated: failedPages.length > 0 || wantPages < Math.ceil(total / FAV_PAGE_SIZE) || all.length > FAV_MAX,
                failedPages: failedPages.length,
            });
        }

        // ---- 一起听房间（M4）----
        if (p === '/api/rooms' && m === 'GET') return json(res, 200, { rooms: rooms.list(ctx) });
        if (p === '/api/rooms' && m === 'POST') {
            return json(res, 200, rooms.create(await readBody(req), ctx));
        }
        // 靠房间名加入（私人房间只能这么进）。必须放在 /api/rooms/:roomId 之前
        if (p === '/api/rooms/join' && m === 'POST') {
            const body = await readBody(req);
            return json(res, 200, rooms.joinByName(body.name, ctx));
        }
        // 凭分享链接里的 token 进房（点别人发的链接走这条）
        if (p === '/api/rooms/join-by-token' && m === 'POST') {
            const body = await readBody(req);
            return json(res, 200, rooms.joinByToken(body.token, ctx));
        }
        // 生成/取回分享 token（房内的人才拿得到）
        mm = p.match(/^\/api\/rooms\/([^/]+)\/share$/);
        if (mm && m === 'POST') {
            return json(res, 200, rooms.shareTokenOf(decodeURIComponent(mm[1]), ctx));
        }
        mm = p.match(/^\/api\/rooms\/([^/]+)\/events$/);
        if (mm && m === 'GET') {
            // SSE：这里不能走 json()，直接接管连接
            rooms.events(req, res, decodeURIComponent(mm[1]), ctx);
            return;
        }
        mm = p.match(/^\/api\/rooms\/([^/]+)\/join$/);
        if (mm && m === 'POST') {
            return json(res, 200, rooms.join(decodeURIComponent(mm[1]), ctx));
        }
        mm = p.match(/^\/api\/rooms\/([^/]+)\/control$/);
        if (mm && m === 'POST') {
            const id = decodeURIComponent(mm[1]);
            const body = await readBody(req);
            // 'ended' 是关键：任何成员都能上报"放完了"，服务端核过时间才切歌
            if (body.action === 'ended') return json(res, 200, rooms.reportEnded(id, ctx));
            return json(res, 200, rooms.control(id, body, ctx));
        }
        mm = p.match(/^\/api\/rooms\/([^/]+)\/grant$/);
        if (mm && m === 'POST') {
            return json(res, 200, rooms.grant(decodeURIComponent(mm[1]), await readBody(req), ctx));
        }
        mm = p.match(/^\/api\/rooms\/([^/]+)\/transfer$/);
        if (mm && m === 'POST') {
            return json(res, 200, rooms.transfer(decodeURIComponent(mm[1]), await readBody(req), ctx));
        }
        // 离开房间时把那批歌并回自己的队列（前端在 leaveRoom 里调，失败也不拦着走）
        mm = p.match(/^\/api\/rooms\/([^/]+)\/pull-queue$/);
        if (mm && m === 'POST') {
            return json(res, 200, rooms.pullQueue(decodeURIComponent(mm[1]), ctx));
        }
        mm = p.match(/^\/api\/rooms\/([^/]+)$/);
        if (mm && m === 'GET') {
            return json(res, 200, rooms.get(decodeURIComponent(mm[1]), ctx));
        }
        // 删房间：只有管理员能做
        if (mm && m === 'DELETE') {
            return json(res, 200, rooms.removeRoomById(decodeURIComponent(mm[1]), ctx));
        }

        if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

        // 静态文件
        // ⚠️ /r/<token> 是房间分享链接的**短路径**形式（2026/10/17 加，见下面注释）：
        //    它不是真文件，要当成首页发出去，让前端自己去解析 token
        const shortRoom = p.match(/^\/r\/[A-Za-z0-9_-]{4,64}\/?$/);
        const rel = p === '/' || shortRoom ? 'index.html' : p.slice(1);
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
            return json(res, 404, { error: 'not found' });
        }
        const isHtml = path.extname(file) === '.html';
        res.writeHead(200, {
            'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'application/octet-stream',
            // 页面必须每次回源校验：否则改完前端，浏览器还在用旧页面，
            // 会出现"代码已经修好了但打开还是坏的"这种假故障
            ...(isHtml ? { 'Cache-Control': 'no-cache' } : {}),
        });
        return fs.createReadStream(file).pipe(res);
    } catch (e) {
        console.error('[ERR]', e.biliCode ?? '', e.message);
        if (!res.headersSent) {
            const body = { error: e.message };
            if (e.biliCode != null) {
                body.biliCode = e.biliCode;
                body.reqUrl = e.reqUrl ?? null;
            }
            json(res, e.status ?? 500, body);
        } else {
            res.end();
        }
    }
});
server.listen(PORT, HOST, () => {
    console.log(`\n  ▶ http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
});
