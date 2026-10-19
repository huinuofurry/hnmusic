// 一起听房间：整个项目只有这个文件知道房间怎么同步。
//
// 已确认事实（§3.7）：同步是**事件驱动**的，不是时钟对齐。
// 各客户端只有"加载时的静态偏移"，不随时间增长 ⇒ 不需要时钟同步、不需要漂移补偿。
// 唯一需要算位置的地方是"迟到者进房"，用锚点算一次，之后只跟事件。
//
// 身份：token 是凭据（只在 Authorization 头里），sid 是公开标识。
// 房间里的 hostId / controllerIds / addedBy 一律用 'u:<userId>' 或 's:<sid>'，绝不出现 token。
// requireTrack 抽到 track.js 了 —— 以前 api.js / rooms.js 各一份，
// 2026/10/15 只放宽了一边，导致"没 cid 的歌点播放没反应"（见 track.js 顶部注释）
import { requireTrack, BATCH_MAX } from './track.js';
import * as api from './api.js'; // 只为了拿到"我自己的队列"（key 规则不重复写第二份）
import crypto from 'node:crypto';
import * as store from './store.js';

const MODES = new Set(['sequence', 'loop-all', 'loop-one', 'shuffle']);
const TICK_MS = 1000;
const PING_MS = 20000;
// 只有"换一首曲子"才需要缓冲窗口；seek / 从暂停恢复都是同一个已加载的音频，
// 加延迟就是纯钝感。原来无脑用 1500ms，实测太慢，改成只给换曲用、并调小。
const TRACK_DELAY = 700;
const SAME_TRACK_DELAY = 0;
// 离线宽限：人断线**不立刻踢**，给 60 秒回来（刷新页面、手机切个 App、
// 地铁里断一下就都算），超时才算真的退出。
// 用户 2026/10/15 明确要求："设置离线后 60 秒没上线再自动退出"。
//
// ⚠️ 原来的实现有两个毛病（都因为"成员是从活跃 SSE 连接实时算的"）：
//   ① 一断线就立刻从成员列表消失 —— 房主刷新一下页面，位子当场就被别人顶了
//   ② 空房回收也跟着活跃连接数走，当时给 5 秒 —— 手机切个 App 回来房间已经没了
// 现在成员表 = 在线的人 ∪ 宽限期内还没回来的缺席者，两者一起排序，
// 所以谁走谁留都不会让列表跳来跳去。
// 测试要跑快可以设 HN_OFFLINE_TTL（毫秒）覆盖。
const OFFLINE_TTL = Number(process.env.HN_OFFLINE_TTL) || 60000;
// 只给"建了房但从来没人进来"用（宽限机制管不到这种）
const EMPTY_ROOM_TTL = Number(process.env.HN_EMPTY_ROOM_TTL) || 5000;
const END_TOLERANCE = 0.6; // 判定"这首已经放完"的容差（秒）

const subs = new Map(); // roomId -> Set<sub>

function fail(status, message) {
    const e = new Error(message);
    e.status = status;
    throw e;
}

function allRooms() {
    return store.getDb().rooms;
}

function findRoom(roomId) {
    if (!roomId) fail(400, '缺少 roomId');
    const r = allRooms().find((x) => x.roomId === roomId);
    if (!r) fail(404, '房间不存在');
    return r;
}

// ---------- 身份 ----------
// 房间里的显示名一律**现算，不要缓存**：昵称随时可能被改，
// 缓存下来的话别人看到的还是旧名字（改昵称后 refreshNames() 会重播一次）
function nameOfKey(key) {
    const db = store.getDb();
    if (key.startsWith('u:')) {
        const u = db.users.find((x) => x.id === key.slice(2));
        return u ? u.displayName || u.username : '（已注销）';
    }
    if (key.startsWith('s:')) return '游客' + key.slice(2, 6);
    return key;
}

// 只读接口用 maybeIdentity（匿名也行，you 给 null）；写操作必须 identityOf
function maybeIdentity(ctx) {
    if (ctx?.userId) return { key: 'u:' + ctx.userId, name: nameOfKey('u:' + ctx.userId) };
    if (ctx?.sid) return { key: 's:' + ctx.sid, name: nameOfKey('s:' + ctx.sid) };
    return null;
}

export function identityOf(ctx) {
    const me = maybeIdentity(ctx);
    if (!me) fail(401, '需要身份：先 POST /api/auth/guest 拿游客令牌，或登录');
    return me;
}

function canControl(room, key) {
    return key === room.hostId || room.controllerIds.includes(key);
}

// ---------- 房间队列（存在 db.queues['r:<roomId>']，和每人一份的队列同一套机制）----------
function roomQueue(room) {
    const db = store.getDb();
    const key = 'r:' + room.roomId;
    if (!db.queues[key]) db.queues[key] = { items: [], currentId: null, mode: 'loop-all' };
    return db.queues[key];
}



// ---------- 播放锚点 ----------
// pos = anchorPosition + (now - anchorServerTime)，isPlaying 时才算
function playheadOf(room) {
    const now = Date.now();
    if (!room.isPlaying) return { position: room.anchorPosition, startsIn: 0 };
    const startsIn = Math.max(0, room.anchorServerTime - now); // > 0 表示还在缓冲窗口里
    const pos = room.anchorPosition + Math.max(0, now - room.anchorServerTime) / 1000;
    return { position: Math.max(0, pos), startsIn };
}

function payloadOf(room) {
    const q = roomQueue(room);
    const { position, startsIn } = playheadOf(room);
    return {
        trackId: q.currentId,
        track: q.items.find((x) => x.id === q.currentId) || null,
        isPlaying: room.isPlaying,
        anchorPosition: room.anchorPosition,
        anchorServerTime: room.anchorServerTime,
        position,
        startsIn, // 前端用这个相对延迟来排播（比绝对服务器时间抗时钟偏差）
        serverTime: Date.now(),
    };
}

// ---------- 成员 ----------
function subSet(roomId) {
    let s = subs.get(roomId);
    if (!s) {
        s = new Set();
        subs.set(roomId, s);
    }
    return s;
}

// 断线的人先记一笔（宽限期内还算房间成员），回来了就删掉这笔
function markAbsent(room, key, joinedAt) {
    room.absent = room.absent || {};
    // 已经在缺席表里就别把 since 往后推（否则一直重连不上就永远不踢）
    if (!room.absent[key]) room.absent[key] = { joinedAt, since: Date.now() };
}
function unmarkAbsent(room, key) {
    if (room.absent && room.absent[key]) delete room.absent[key];
}
// 宽限期内还没回来的成员
function absentList(room) {
    const now = Date.now();
    const out = [];
    for (const [key, rec] of Object.entries(room.absent || {})) {
        if (now - rec.since > OFFLINE_TTL) continue;
        out.push({ key, name: nameOfKey(key), joinedAt: rec.joinedAt, offline: true });
    }
    return out;
}

// 成员 = 在线的人 ∪ 宽限期内还没回来的缺席者。
// `offline: true` 让前端把这些人显示成灰的（别让人以为他还在听）。
function memberList(room) {
    const out = [];
    const seen = new Set();
    for (const sub of subSet(room.roomId)) {
        if (seen.has(sub.key)) continue;
        seen.add(sub.key);
        out.push({ key: sub.key, name: nameOfKey(sub.key), joinedAt: sub.joinedAt });
    }
    for (const m of absentList(room)) {
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        out.push(m);
    }
    return out.sort((a, b) => a.joinedAt - b.joinedAt);
}

// ---------- 序列化（对外唯一出口，注意别把 token 带出去）----------
function serialize(room, me) {
    const q = roomQueue(room);
    const { position, startsIn } = playheadOf(room);
    return {
        roomId: room.roomId,
        name: room.name,
        hostId: room.hostId,
        isPrivate: !!room.isPrivate,
        controllerIds: room.controllerIds.slice(),
        createdAt: room.createdAt,
        trackId: q.currentId,
        track: q.items.find((x) => x.id === q.currentId) || null,
        isPlaying: room.isPlaying,
        anchorPosition: room.anchorPosition,
        anchorServerTime: room.anchorServerTime,
        position,
        startsIn,
        serverTime: Date.now(),
        mode: q.mode,
        queue: { items: q.items, currentId: q.currentId, mode: q.mode },
        members: memberList(room),
        you: me ? { key: me.key, name: me.name, isHost: me.key === room.hostId, canControl: canControl(room, me.key) } : null,
    };
}

// ---------- SSE ----------
function write(res, event, data) {
    try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
        /* 连接已经断了，等 close 事件去清理 */
    }
}

function broadcast(room, event, data) {
    for (const sub of subSet(room.roomId)) write(sub.res, event, data);
}

// ---------- 队列事件只发"增量"（2026/10/16 改）----------
// 原来是**每次都把整份队列**塞进 SSE 广播里 ✗ ——
// 实测（服务器 3Mbps、5 个人在听）上行跑到 400 KB/s，而音频本身只占 120 KB/s：
// 房间队列 1000 首 ≈ 280 KB，每加一首歌就 × 每个听众 发一遍。
// 现在只发"变化的那一点"，客户端自己按增量改本地队列：
//   queue-add     { item, afterId }        afterId=null 表示排在最前面
//   queue-add     { items }                批量（永远追加在末尾）
//   queue-remove  { itemId, currentId }
//   queue-reorder { order: [id, id, ...] } 只发顺序，不发内容（1000 首约 6 KB）
//   queue-clear   { cleared: true, currentId: null }
// ⚠️ 客户端仍然**兼容**旧的整份报文（`data.queue`）—— 万一有人开着旧页面，
//    不至于看到空队列。
function afterIdOf(q, item) {
    const i = q.items.findIndex((x) => x.id === item.id);
    return i > 0 ? q.items[i - 1].id : null;
}
function orderOf(q) {
    return q.items.map((x) => x.id);
}

// 权限相关的字段是"每人不同"的，只能单独发
function broadcastYou(room) {
    for (const sub of subSet(room.roomId)) {
        write(sub.res, 'you', {
            key: sub.key,
            isHost: sub.key === room.hostId,
            canControl: canControl(room, sub.key),
            controllerIds: room.controllerIds.slice(),
        });
    }
}

export function events(req, res, roomId, ctx) {
    const room = findRoom(roomId);
    const me = identityOf(ctx);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // 万一以后挂在 Caddy/nginx 后面，别缓冲
    });
    res.write('retry: 3000\n\n');

    const sub = { res, key: me.key, name: me.name, joinedAt: Date.now() };
    subSet(room.roomId).add(sub);
    room.emptySince = null;
    // 回来了：把"缺席"那笔划掉（宽限期结束）
    unmarkAbsent(room, me.key);

    // 空房间进来第一个人 → 他就是房主（房主离开后房间不会卡死）
    if (!room.hostId) {
        room.hostId = sub.key;
        room.controllerIds = [];
        store.save();
    }

    write(res, 'state', serialize(room, me)); // 迟到者靠这个算一次位置
    broadcast(room, 'members', { members: memberList(room) });
    broadcast(room, 'host', { hostId: room.hostId });
    broadcastYou(room);

    res.on('close', () => {
        const set = subs.get(room.roomId);
        if (set) {
            set.delete(sub);
            if (!set.size) subs.delete(room.roomId);
        }
        // ⚠️ 这里**不立刻**把房主位子交出去、也不立刻从成员列表里删人 ——
        //    先记一笔"缺席"，给 60 秒宽限（HN_OFFLINE_TTL 可覆盖）。
        //    真的过期由 tick() 处理：那时才踢人、才换房主。
        //    （原来在这里立刻换房主，结果房主刷新一下页面位子就没了）
        markAbsent(room, sub.key, sub.joinedAt);
        broadcast(room, 'members', { members: memberList(room) });
        broadcastYou(room);
    });
}

// ---------- 房间增删查 ----------
// 房间列表。**管理员能看到所有房间**（私人房会带 isPrivate 标记，前端挂把锁）；
// 普通人只看得到公开房 + 自己开的私人房。
export function list(ctx) {
    const me = maybeIdentity(ctx);
    const mine = me ? me.key : null;
    const isAdmin = !!ctx && ctx.role === 'admin';
    return allRooms()
        .filter((room) => isAdmin || !room.isPrivate || room.hostId === mine)
        .map((room) => {
            const q = roomQueue(room);
            return {
                roomId: room.roomId,
                name: room.name,
                hostId: room.hostId,
                isPrivate: !!room.isPrivate,
                members: memberList(room).length,
                track: q.items.find((x) => x.id === q.currentId) || null,
                isPlaying: room.isPlaying,
            };
        });
}

// 删房间。两种人都能做：
//   房主 —— 解散自己开的房间（前端【解散】按钮）
//   管理员 —— 删任意房间（前端列表里那个 ✕）
// 先把在房间里的人踢出去（广播 deleted，前端收到就当作"房间没了"退回普通状态），再真的删。
export function removeRoomById(roomId, ctx) {
    const me = maybeIdentity(ctx);
    const room = allRooms().find((r) => r.roomId === roomId);
    if (!room) fail(404, '房间不存在');
    const isAdmin = !!ctx && ctx.role === 'admin';
    const isHost = !!me && me.key === room.hostId;
    if (!isAdmin && !isHost) fail(403, '只有房主或管理员能删房间');
    broadcast(room, 'deleted', { roomId: room.roomId, name: room.name });
    removeRoom(room);
    return { ok: true, roomId: room.roomId };
}

export function create(body = {}, ctx) {
    const me = identityOf(ctx);
    const name = String(body.name ?? '').trim();
    if (!name) fail(400, '房间名不能为空');
    if (name.length > 40) fail(400, '房间名最长 40');
    const room = {
        roomId: store.nextId('r'),
        name,
        hostId: me.key,
        isPrivate: !!body.isPrivate, // 私人房间不上房间列表
        controllerIds: [],
        createdAt: Date.now(),
        isPlaying: false,
        anchorPosition: 0,
        anchorServerTime: 0,
        emptySince: null,
        absent: {}, // 断线宽限期内的人（key -> { joinedAt, since }）
    };
    allRooms().push(room);
    roomQueue(room);
    // 开房时**把自己队列里的歌带进房间**（用户 2026/10/16："开房…保留当前歌曲列表"）。
    // 不带的话新房间是空的，你刚在听的几十上百首得一首首重新加。
    // 用"复制"而不是"搬家"：你自己的队列保持不动，退房时那份还在。
    try {
        const mine = api.ownQueue(ctx);
        if (mine.items.length) {
            const q = roomQueue(room);
            q.items = mine.items.map((it) => ({ ...it, id: store.nextId(), addedBy: me.key, addedAt: Date.now() }));
            // ⚠️ 当前曲目**跟着你自己的队列走**（2026/10/17 用户："开创房间以后保留
            //    队列当前播放到的进度"）—— 原来总是从第一首开始，
            //    等于每次开房都把"我听到哪了"清掉 ✗
            const curIdx = mine.items.findIndex((x) => x.id === mine.currentId);
            q.currentId = q.items[curIdx >= 0 ? curIdx : 0] ? q.items[curIdx >= 0 ? curIdx : 0].id : null;
            // 进度秒数由客户端带过来（只有它知道音频放到第几秒了）
            const pos = Number(body.position);
            room.anchorPosition = Number.isFinite(pos) && pos > 0 ? pos : 0;
            room.anchorServerTime = Date.now();
            // 房间先不播：等房主进来按播放（自动播会被浏览器拦，反而以为坏了）
            room.isPlaying = false;
        }
    } catch {
        /* 没身份之类的情况：开个空房就是了，别把建房搞失败 */
    }
    store.save();
    return serialize(room, me);
}

// 离开房间时把房间那批歌**并回你自己的队列**（用户 2026/10/16："离开…保留当前歌曲列表"）。
// ⚠️ 用"合并去重"而不是"整体替换"：房间队列通常是你自己那份的超集
//（开房时带进去的 + 后来在房间里加的），合并等于"把自己没有的补上"，
// 这样**永远不会有东西被删掉** —— 拿别人的房间也一样安全。
export function pullQueue(roomId, ctx) {
    const room = findRoom(roomId);
    const q = roomQueue(room);
    const mine = api.ownQueue(ctx);
    const seen = new Set(mine.items.map((x) => x.bvid + ':' + x.cid));
    let added = 0;
    for (const it of q.items) {
        const k = it.bvid + ':' + it.cid;
        if (seen.has(k)) continue;
        seen.add(k);
        const { addedBy, ...keep } = it; // 房间里的"谁加的"带出来没意义
        mine.items.push({ ...keep, id: store.nextId() });
        added++;
    }
    // 顺便把"正在播的那首"也定位过去 —— 不然退房后你会从头开始放
    const cur = q.items.find((x) => x.id === q.currentId);
    if (cur) {
        const same = mine.items.find((x) => x.bvid === cur.bvid && x.cid === cur.cid);
        if (same) mine.currentId = same.id;
    }
    if (added) store.save();
    return { added, total: mine.items.length };
}

// 分享链接用的随机 token（房内的人点【分享】才拿得到）。
// 不用 roomId 当链接：roomId 是 r1/r2 这种自增的，猜得到，
// 私人房靠它保密就等于没保密。
export function shareTokenOf(roomId, ctx) {
    const room = findRoom(roomId);
    const me = identityOf(ctx);
    if (!memberList(room).some((m) => m.key === me.key)) fail(403, '你不在这个房间里');
    if (!room.shareToken) {
        room.shareToken = crypto.randomBytes(9).toString('base64url');
        store.save();
    }
    return { token: room.shareToken, name: room.name, isPrivate: !!room.isPrivate };
}

// 凭分享 token 进房（链接点进来走这条）
export function joinByToken(token, ctx) {
    const me = identityOf(ctx);
    const want = String(token ?? '').trim();
    if (!want) fail(400, '缺少 token');
    const room = allRooms().find((r) => r.shareToken === want);
    if (!room) fail(404, '这个邀请链接已经失效了');
    return serialize(room, me);
}

// 靠房间名加入（私人房间的另一个入口）。
// 房间名不要求唯一，同名时优先"里面有人"的，其次最新的那个。
export function joinByName(name, ctx) {
    const me = identityOf(ctx);
    const want = String(name ?? '').trim().toLowerCase();
    if (!want) fail(400, '缺少房间名');
    const hits = allRooms().filter((r) => String(r.name).trim().toLowerCase() === want);
    if (!hits.length) fail(404, '没有叫这个名字的房间');
    hits.sort((a, b) => {
        const sa = subs.has(a.roomId) ? 1 : 0;
        const sb = subs.has(b.roomId) ? 1 : 0;
        if (sa !== sb) return sb - sa;
        return b.createdAt - a.createdAt;
    });
    return serialize(hits[0], me);
}

export function get(roomId, ctx) {
    const room = findRoom(roomId);
    return serialize(room, maybeIdentity(ctx)); // 只读：匿名也能看，you 为 null
}

export function join(roomId, ctx) {
    const room = findRoom(roomId);
    const me = identityOf(ctx);
    // 重启恢复出来的房间：第一个人进来时**接管房主**（如果他自己不是房主）
    // —— 否则原房主不回来的话，房间里没人能切歌，整个房间就是死的 ✗
    // ⚠️ 只在"刚从重启恢复、且还没人进来过"时做这一次；
    //    正常的断线宽限**绝不能**换房主（那是"刷新一下房主就没了"那个 bug ✗）
    if (room.restored) {
        const first = !memberList(room).length;
        if (first && me.key !== room.hostId) {
            room.hostId = me.key;
            room.controllerIds = [];
        }
        if (first) {
            room.restored = false;
            room.emptySince = null;
        }
        store.save();
    }
    return serialize(room, me);
}

// ---------- 播放控制 ----------
function applyPlay(room, body) {
    const q = roomQueue(room);
    if (!q.currentId) fail(400, '队列里没有歌');
    const pos = Number(body.position);
    room.anchorPosition = Number.isFinite(pos) && pos >= 0 ? pos : playheadOf(room).position;
    // 只是"继续播"，曲子没换，各端早就加载好了 —— 不加缓冲窗口
    room.anchorServerTime = Date.now() + SAME_TRACK_DELAY;
    room.isPlaying = true;
}

function applyPause(room) {
    room.anchorPosition = playheadOf(room).position;
    room.anchorServerTime = Date.now();
    room.isPlaying = false;
}

function applySeek(room, body) {
    const pos = Number(body.position);
    if (!Number.isFinite(pos) || pos < 0) fail(400, 'position 不合法');
    room.anchorPosition = pos;
    // 拖进度条也是同一首已加载的音频，立即生效（这里原来错加了 1.5 秒延迟）
    room.anchorServerTime = Date.now() + SAME_TRACK_DELAY;
}

function applyMove(room, dir) {
    const q = roomQueue(room);
    if (!q.items.length) fail(400, '队列是空的');
    let idx = q.items.findIndex((x) => x.id === q.currentId);
    if (idx < 0) idx = 0;
    const prev = dir === 'prev';
    let next;
    if (q.mode === 'shuffle' && q.items.length > 1) {
        next = idx;
        while (next === idx) next = Math.floor(Math.random() * q.items.length);
    } else if (q.mode === 'loop-all') {
        next = prev ? (idx - 1 + q.items.length) % q.items.length : (idx + 1) % q.items.length;
    } else if (prev) {
        if (idx <= 0) {
            room.anchorPosition = 0;
            room.anchorServerTime = Date.now();
            return 'prev';
        }
        next = idx - 1;
    } else {
        if (idx >= q.items.length - 1) {
            // 顺序模式播到底：停下，但状态是服务端权威的，谁看都一样
            room.isPlaying = false;
            room.anchorPosition = 0;
            room.anchorServerTime = Date.now();
            return 'ended';
        }
        next = idx + 1;
    }
    q.currentId = q.items[next].id;
    room.anchorPosition = 0;
    room.anchorServerTime = room.isPlaying ? Date.now() + TRACK_DELAY : Date.now();
    return prev ? 'prev' : 'next';
}

export function control(roomId, body = {}, ctx) {
    const room = findRoom(roomId);
    const me = identityOf(ctx);
    const action = String(body.action ?? '');
    const q = roomQueue(room);

    // 队列类是"人人可加"，只有删别人的、以及切歌才有限制
    if (action === 'queue-add') {
        const track = requireTrack(body);
        const playNow = !!body.playNow;
        // 同一首（bvid+cid）已经在队列里就不再追加一份，避免"一直点一直加"
        const dup = q.items.find((x) => x.bvid === track.bvid && x.cid === track.cid);
        if (dup) {
            if (playNow) {
                if (!canControl(room, me.key)) fail(403, '只有房主（或房主授权的人）能切歌');
                q.currentId = dup.id;
                room.anchorPosition = 0;
                room.anchorServerTime = Date.now() + TRACK_DELAY;
                room.isPlaying = true;
                store.save();
                broadcast(room, 'play', payloadOf(room));
                return { ...serialize(room, me), duplicate: true };
            }
            let moved = false;
            if (body.next && q.items.length > 1) {
                // next:true 的语义 = 让这首排在下一位，所以把它挪过去而不是再加一份
                q.items.splice(q.items.indexOf(dup), 1);
                const curIdx = q.items.findIndex((x) => x.id === q.currentId);
                q.items.splice(curIdx < 0 ? q.items.length : curIdx + 1, 0, dup);
                moved = true;
                store.save();
                // 只发增量（见下面 afterIdOf 的注释）
                broadcast(room, 'queue-add', { item: dup, afterId: afterIdOf(q, dup), moved: true, by: me.key, duplicate: true });
            }
            return { ...serialize(room, me), duplicate: true, moved };
        }
        const item = {
            id: store.nextId(),
            ...track,
            addedBy: me.key,
            addedAt: Date.now(),
        };
        if (!q.items.length) {
            q.items.push(item);
            q.currentId = item.id;
        } else if (body.next) {
            const idx = q.items.findIndex((x) => x.id === q.currentId);
            q.items.splice(idx < 0 ? q.items.length : idx + 1, 0, item);
        } else {
            q.items.push(item);
        }
        // playNow = "加进去并马上放这首"，那是切歌行为，要控制权
        if (playNow) {
            if (!canControl(room, me.key)) fail(403, '只有房主（或房主授权的人）能切歌');
            q.currentId = item.id;
            room.anchorPosition = 0;
            room.anchorServerTime = Date.now() + TRACK_DELAY;
            room.isPlaying = true;
        }
        store.save();
        broadcast(room, 'queue-add', { item, afterId: afterIdOf(q, item), by: me.key });
        if (playNow) broadcast(room, 'play', payloadOf(room));
        else if (q.items.length === 1) broadcast(room, 'playback', payloadOf(room));
        return serialize(room, me);
    }

    // 一次加多首（房间里的"播放整个歌单"），避免前端发几十个请求
    if (action === 'queue-add-batch') {
        const list = Array.isArray(body.tracks) ? body.tracks : [];
        if (!list.length) fail(400, '缺少 tracks');
        if (list.length > BATCH_MAX) fail(400, '一次最多加 ' + BATCH_MAX + ' 首（一个歌单的上限）');
        const playNow = !!body.playNow;
        if (playNow && !canControl(room, me.key)) fail(403, '只有房主（或房主授权的人）能切歌');
        // 先记下这批的**第一首** —— 下面"全都已在队列里"那种情况要用它来切歌
        const firstTrack = requireTrack(list[0]);
        // 跳过队列里已有的，顺便去掉这批自己内部的重复
        const fresh = [];
        const seen = new Set(q.items.map((x) => x.bvid + ':' + x.cid));
        for (const t of list) {
            const track = requireTrack(t);
            const key = track.bvid + ':' + track.cid;
            if (seen.has(key)) continue;
            seen.add(key);
            fresh.push({ id: store.nextId(), ...track, addedBy: me.key, addedAt: Date.now() });
        }
        const skipped = list.length - fresh.length;
        if (!fresh.length) {
            // ⚠️ 一首都没加（全都在队列里了）**不能就这么 return** ——
            //    用户按的是【播放全部】，期待的是"开始播"。
            //    房主最容易踩：他自己那个歌单早就整份在队列里了，
            //    按了播放全部却什么也不发生（用户 2026/10/16 报的"按了播放没跳转播放"）。
            //    这时把这批的**第一首**切为当前项并开始播。
            if (playNow) {
                const first = q.items.find((x) => x.bvid === firstTrack.bvid && x.cid === firstTrack.cid);
                if (first) {
                    q.currentId = first.id;
                    room.anchorPosition = 0;
                    room.anchorServerTime = Date.now() + TRACK_DELAY;
                    room.isPlaying = true;
                    store.save();
                    broadcast(room, 'play', payloadOf(room));
                }
            }
            return { ...serialize(room, me), duplicate: true, skipped, started: !!playNow };
        }
        const wasEmpty = !q.items.length;
        q.items.push(...fresh);
        if (wasEmpty) q.currentId = fresh[0].id;
        if (playNow) {
            q.currentId = fresh[0].id;
            room.anchorPosition = 0;
            room.anchorServerTime = Date.now() + TRACK_DELAY;
            room.isPlaying = true;
        }
        store.save();
        broadcast(room, 'queue-add', { items: fresh, by: me.key, count: fresh.length });
        if (playNow) broadcast(room, 'play', payloadOf(room));
        else if (wasEmpty) broadcast(room, 'playback', payloadOf(room));
        return { ...serialize(room, me), skipped };
    }

    if (action === 'queue-remove') {
        const i = q.items.findIndex((x) => x.id === body.itemId);
        if (i < 0) fail(404, '条目不存在');
        const it = q.items[i];
        // 只能删自己加的；房主可以删任意
        if (it.addedBy !== me.key && me.key !== room.hostId) fail(403, '只能删自己加的曲子');
        q.items.splice(i, 1);
        if (q.currentId === it.id) {
            q.currentId = q.items[Math.min(i, q.items.length - 1)]?.id ?? null;
            room.anchorPosition = 0;
            room.anchorServerTime = Date.now();
            if (!q.currentId) room.isPlaying = false;
        }
        store.save();
        broadcast(room, 'queue-remove', { itemId: it.id, currentId: q.currentId, by: me.key });
        broadcast(room, 'playback', payloadOf(room));
        return serialize(room, me);
    }

    // 【调整顺序】—— 和 queue-remove 一样，放在 canControl 门槛**之前**：
    // 房主控制"播哪首"，但"把自己加的歌往前提"人人都该能做 ——
    // 不然你加的歌排在 12 首后面，就只能干等（用户 2026/10/15 要求的）。
    // 只动队列顺序，**不打断正在播的那首**（那不是切歌）。
    if (action === 'queue-move') {
        const i = q.items.findIndex((x) => x.id === body.itemId);
        if (i < 0) fail(404, '条目不存在');
        const it = q.items[i];
        // 只能挪自己加的；房主可以挪任意（和 queue-remove 的权限一致）
        if (it.addedBy !== me.key && me.key !== room.hostId) fail(403, '只能调整你自己加的曲子');
        // 正在播的那首不用挪（它本来就在"下一位"前面）
        if (it.id === q.currentId) return serialize(room, me);
        let at;
        if (body.toNext) {
            // 【下一位】：塞到当前这首的后面（前端一键用这个，免得算下标算错）
            const curAt = q.items.findIndex((x) => x.id === q.currentId);
            at = curAt < 0 ? q.items.length : curAt + 1;
        } else {
            at = Number(body.toIndex);
            if (!Number.isInteger(at) || at < 0 || at >= q.items.length) fail(400, 'toIndex 不合法');
        }
        if (i !== at) {
            q.items.splice(i, 1);
            // 挪走之后，目标位置在它前面的要减 1
            q.items.splice(i < at ? at - 1 : at, 0, it);
            store.save();
            // 前端对 queue-* 事件是通用处理（event.startsWith('queue-')），
            // 所以复用 queue-reorder 这个名字，前端一行都不用改
            // 只发顺序（id 列表）：1000 首的 id 列表约 6 KB，整份队列要 280 KB ✗
            broadcast(room, 'queue-reorder', { order: orderOf(q), by: me.key });
        }
        return serialize(room, me);
    }

    // 以下都是"控制播放"，必须房主或被授权的人
    if (!canControl(room, me.key)) fail(403, '只有房主（或房主授权的人）能控制播放');

    if (action === 'queue-reorder') {
        const at = Number(body.toIndex);
        if (!Number.isInteger(at) || at < 0 || at >= q.items.length) fail(400, 'toIndex 不合法');
        const from = q.items.findIndex((x) => x.id === body.itemId);
        if (from < 0) fail(404, '条目不存在');
        const [it] = q.items.splice(from, 1);
        q.items.splice(at, 0, it);
        store.save();
        broadcast(room, 'queue-reorder', { order: orderOf(q) });
        return serialize(room, me);
    }

    if (action === 'queue-clear') {
        q.items = [];
        q.currentId = null;
        room.isPlaying = false;
        room.anchorPosition = 0;
        room.anchorServerTime = Date.now();
        store.save();
        broadcast(room, 'queue-clear', { cleared: true, currentId: null });
        broadcast(room, 'playback', payloadOf(room));
        return serialize(room, me);
    }

    if (action === 'set-mode') {
        if (!MODES.has(body.mode)) fail(400, 'mode 不合法');
        q.mode = body.mode;
        store.save();
        broadcast(room, 'mode', { mode: q.mode });
        return serialize(room, me);
    }

    if (action === 'play') {
        applyPlay(room, body);
    } else if (action === 'play-item') {
        // 点房间队列里的某一首，直接切过去放
        const it = q.items.find((x) => x.id === body.itemId);
        if (!it) fail(404, '条目不存在');
        q.currentId = it.id;
        room.anchorPosition = 0;
        room.anchorServerTime = Date.now() + TRACK_DELAY;
        room.isPlaying = true;
    } else if (action === 'pause') {
        applyPause(room);
    } else if (action === 'seek') {
        applySeek(room, body);
    } else if (action === 'next' || action === 'prev') {
        const ev = applyMove(room, action);
        store.save();
        broadcast(room, ev, payloadOf(room));
        return serialize(room, me);
    } else {
        fail(400, 'action 不认识: ' + action);
    }

    store.save();
    broadcast(room, action, payloadOf(room));
    return serialize(room, me);
}

// 任何成员都可以上报"这首放完了"，但服务端要核一下时间，防止有人拿它当任意切歌
export function reportEnded(roomId, ctx) {
    const room = findRoom(roomId);
    identityOf(ctx);
    const q = roomQueue(room);
    const cur = q.items.find((x) => x.id === q.currentId);
    if (!room.isPlaying || !cur) return { ok: false, reason: '当前没有在播的歌' };
    const dur = Number(cur.duration) || 0;
    const pos = playheadOf(room).position;
    if (!dur || pos < dur - 3) return { ok: false, reason: '还没放到结尾' };
    const ev = applyMove(room, 'next');
    store.save();
    broadcast(room, ev, payloadOf(room));
    return { ok: true };
}

// ---------- 授权 ----------
// 转让房主：把房主位子交给房间里的另一个人，原房主变成普通成员。
// ⚠️ 这跟 grant（授权）不是一回事：grant 是"让你也能控制，但房主还是我"；
// transfer 是真的把位子交出去 —— 交完自己就只剩"加曲子"了。
export function transfer(roomId, body = {}, ctx) {
    const room = findRoom(roomId);
    const me = identityOf(ctx);
    // 房主能转让；**管理员随时能改**（用户 2026/10/16："改成管理员可以随时改房主得了"）——
    // 不用等房主离开，也不用他同意。这是私人小站，管理员就是站长，
    // 房主因为刷新/离开被系统交接给别人时，他能一句话改回来。
    const isAdmin = !!(ctx && ctx.role === 'admin');
    if (me.key !== room.hostId && !isAdmin) fail(403, '只有房主（或管理员）能改房主');
    const target = String(body.target ?? '').trim();
    if (!target) fail(400, '缺少 target');
    if (target === room.hostId) fail(400, '他已经是房主了');
    // ⚠️ 目标必须**在房间里**（成员表里，含宽限期内离线的人）。
    //    管理员把房主给一个不在房间里的人是没有意义的
    if (!memberList(room).some((m) => m.key === target)) fail(404, '这个人不在房间里');
    room.hostId = target;
    room.controllerIds = room.controllerIds.filter((k) => k !== target); // 新房主不用挂在授权名单里
    store.save();
    broadcast(room, 'host', { hostId: room.hostId });
    broadcast(room, 'members', { members: memberList(room) });
    broadcastYou(room); // 两边都要重算 isHost / canControl
    return serialize(room, me);
}

export function grant(roomId, body = {}, ctx) {
    const room = findRoom(roomId);
    const me = identityOf(ctx);
    if (me.key !== room.hostId) fail(403, '只有房主能授权');
    const target = String(body.target ?? '').trim();
    if (!target) fail(400, '缺少 target');
    if (target === room.hostId) fail(400, '房主本来就能控制');
    const inRoom = memberList(room).some((m) => m.key === target);
    if (!inRoom) fail(404, '这个人不在房间里');
    const allow = body.allow !== false;
    const has = room.controllerIds.includes(target);
    if (allow && !has) room.controllerIds.push(target);
    if (!allow && has) room.controllerIds = room.controllerIds.filter((k) => k !== target);
    store.save();
    broadcast(room, 'grant', { controllerIds: room.controllerIds.slice(), target, allow });
    broadcastYou(room);
    return serialize(room, me);
}

// ---------- 服务端接管 ----------
// 有人改了昵称：把他所在的房间的成员列表重播一遍，别人立刻看到新名字。
// 注意只发 members，不要发整份 state —— 那会让前端重新套用播放状态、把音频打断。
export function refreshNames(userId) {
    const key = 'u:' + userId;
    for (const room of allRooms()) {
        const members = memberList(room);
        if (!members.some((m) => m.key === key)) continue;
        broadcast(room, 'members', { members });
    }
}

export function removeRoom(room) {
    const db = store.getDb();
    db.rooms = db.rooms.filter((r) => r.roomId !== room.roomId);
    delete db.queues['r:' + room.roomId];
    subs.delete(room.roomId);
    store.save();
}

// 启动时把房间**恢复**出来（原来是全清掉，2026/10/16 改）
//
// 用户原话：「希望上线的时候也能保留上次听到的队列的位置」——
// 每次部署/升级都要踢人本来就够烦了，回来发现房间和那 158 首一起没了更烦 ✗
//
// 重启后 SSE 全断了，所以要还原成"没人在里面、暂停在离开那一刻"的样子：
//   · 成员表/断线宽限名单（内存态）清掉
//   · 暂停（isPlaying=false），位置**冻结**在 anchorPosition
//   · restored 标记：空房回收对它网开一面（见 tick），等第一个人进来再恢复正常策略
export function restoreAll() {
    const db = store.getDb();
    const now = Date.now();
    if (!Array.isArray(db.rooms)) db.rooms = [];
    for (const room of db.rooms) {
        // ⚠️ 先把"现在跑到哪了"算出来再冻住 ——
        //    播放中的位置是 `anchorPosition + (now - anchorServerTime)` 算出来的，
        //    anchorPosition 只记着"这次是从哪儿开始播的"（常常是 0）。
        //    直接把它当位置存就会**归零** ✗（第一次就是这么错的，被测试抓到）
        const pos = playheadOf(room).position;
        if (Number.isFinite(pos) && pos >= 0) room.anchorPosition = pos;
        room.absent = {};
        room.isPlaying = false;
        room.anchorServerTime = now; // 冻在这儿（playheadOf 里 isPlaying=false 就不再累加）
        room.emptySince = now;
        room.restored = true; // 第一个人进来时清掉
    }
    subs.clear();
    return db.rooms.length;
}

// 兼容旧名字：测试和文档里可能还写着 resetAll
export function resetAll() {
    const db = store.getDb();
    for (const room of db.rooms) delete db.queues['r:' + room.roomId];
    db.rooms = [];
    subs.clear();
}

// 每秒做两件事：回收空房间；**歌曲放完了服务端自己切下一首**，
// 这样房主关掉网页/睡着了，房间也不会卡在同一首歌上（§六 M4）
function tick() {
    const now = Date.now();
    for (const room of allRooms().slice()) {
        // ---------- 离线宽限到期：这才算真的退出 ----------
        let rosterChanged = false;
        let hostChanged = false;
        for (const [key, rec] of Object.entries(room.absent || {})) {
            if (now - rec.since <= OFFLINE_TTL) continue;
            delete room.absent[key];
            rosterChanged = true;
            room.controllerIds = room.controllerIds.filter((k) => k !== key);
            if (room.hostId === key) {
                const rest = memberList(room); // 已经删掉他了，剩下最早的接手
                room.hostId = rest.length ? rest[0].key : null;
                hostChanged = true;
            }
        }
        if (rosterChanged) {
            store.save();
            broadcast(room, 'members', { members: memberList(room) });
            if (hostChanged) broadcast(room, 'host', { hostId: room.hostId });
            broadcastYou(room);
        }

        // ---------- 房间回收 ----------
        // ⚠️ 判据是"**成员表空了**"，不是"活跃 SSE 数 = 0"：
        //    后者会让人一断线（还没到宽限）房间就被删 —— 原来 5 秒就是这么坑的。
        // ⚠️ "重启恢复出来、还没人进来过"的房间例外：给 7 天，别 5 秒就回收
        //    （2026/10/16：用户要求部署/重启后还能回到原来的房间和位置）
        if (!memberList(room).length) {
            const ttl = room.restored ? 7 * 24 * 3600e3 : EMPTY_ROOM_TTL;
            if (!room.emptySince) room.emptySince = now;
            else if (now - room.emptySince > ttl) {
                removeRoom(room);
                continue;
            }
        } else if (room.emptySince) {
            room.emptySince = null;
        }
        if (!room.isPlaying) continue;
        const q = roomQueue(room);
        const cur = q.items.find((x) => x.id === q.currentId);
        if (!cur) {
            room.isPlaying = false;
            store.save();
            continue;
        }
        const dur = Number(cur.duration) || 0;
        if (!dur) continue;
        const pos = room.anchorPosition + (now - room.anchorServerTime) / 1000;
        if (pos >= dur - END_TOLERANCE) {
            const ev = applyMove(room, 'next');
            store.save();
            broadcast(room, ev, payloadOf(room));
        }
    }
}

let ticker = null;
let pinger = null;
export function startTickers() {
    if (!ticker) {
        ticker = setInterval(tick, TICK_MS);
        ticker.unref?.();
    }
    if (!pinger) {
        pinger = setInterval(() => {
            for (const set of subs.values()) {
                for (const sub of set) {
                    try {
                        sub.res.write(': ping\n\n');
                    } catch {
                        /* 断了就算了 */
                    }
                }
            }
        }, PING_MS);
        pinger.unref?.();
    }
}
