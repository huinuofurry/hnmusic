// requireTrack 抽到 track.js 了 —— 以前 api.js / rooms.js 各一份，
// 2026/10/15 只改了一边导致"没 cid 的歌点播放没反应"（见 track.js 顶部注释）
import { requireTrack, PLAYLIST_MAX } from './track.js';
import * as store from './store.js';

const MODES = new Set(['sequence', 'loop-all', 'loop-one', 'shuffle']);

function fail(status, message) {
    const e = new Error(message);
    e.status = status;
    throw e;
}

function requireName(name) {
    const n = String(name ?? '').trim();
    if (!n) fail(400, 'name 不能为空');
    if (n.length > 60) fail(400, 'name 最长 60');
    return n;
}

// 单个歌单最多多少首（PLAYLIST_MAX）在 track.js 里，只定义一份

function makeItem(body) {
    const t = requireTrack(body);
    return {
        id: store.nextId(),
        ...t,
        addedAt: Date.now(),
    };
}

function requireUser(auth) {
    if (!auth || !auth.userId) fail(401, '需要登录');
    return auth.userId;
}

// ---------- 队列：每人一份 ----------
// §5.1：队列归属"某个房间"；不在房间时，每个人就是自己的房主，所以每人一条队列。
// 键：'u:<userId>' 登录用户 / 's:<token>' 游客会话 / 'r:<roomId>' 房间（M4 用）
function queueKeyOf(auth) {
    if (auth?.userId) return 'u:' + auth.userId;
    if (auth?.token) return 's:' + auth.token;
    fail(401, '需要身份：先 POST /api/auth/guest 拿游客令牌，或登录');
}

function getQueueFor(key) {
    const db = store.getDb();
    const q = db.queues[key];
    if (!q) {
        const fresh = { items: [], currentId: null, mode: 'loop-all' };
        db.queues[key] = fresh;
        return fresh;
    }
    return q;
}

// 我自己的队列（写操作都用这个）
function myQueue(auth) {
    return getQueueFor(queueKeyOf(auth));
}

// 没有身份时给个空的占位，让 GET /api/state 依然 200（前端一定会先拿游客令牌）
export function emptyQueue() {
    return { items: [], currentId: null, mode: 'loop-all' };
}

// 给 rooms.js 用：按 ctx 取出"我自己的队列"。
// 导出它是为了**不让队列 key 的规则出现第二份**（`u:<userId>` / `s:<token>`）——
// 今天已经因为"两份平行实现"栽过一次（见 track.js 顶部）。
// rooms.js 需要它来做两件事：开房时把自己的队列带进房间、
// 离开房间时把房间那批歌并回自己的队列。
export function ownQueue(ctx) {
    return getQueueFor(queueKeyOf(ctx));
}

// 会话过期后把对应的游客队列一起清掉，避免 db 无限膨胀。
// ⚠️ **必须返回删掉的条数**：调用方靠它决定要不要 store.save() ——
//    不返回的话 `a + undefined = NaN`，`if (n)` 永远为假 ⇒ 清了但没落盘 ✗
//    （2026/10/16 自己 review 时抓到的，定期清理那条路就是这么被静默废掉的）
export function pruneQueues() {
    const db = store.getDb();
    const userIds = new Set(db.users.map((u) => 'u:' + u.id));
    const tokens = new Set(db.sessions.map((s) => 's:' + s.token));
    let removed = 0;
    for (const k of Object.keys(db.queues)) {
        // 'legacy' 和将来房间的 'r:' 都不动
        if (k.startsWith('u:') && !userIds.has(k)) {
            delete db.queues[k];
            removed++;
        } else if (k.startsWith('s:') && !tokens.has(k)) {
            delete db.queues[k];
            removed++;
        }
    }
    return removed;
}

// 游客先加了歌、再去注册/登录：把游客队列过继给新账号，别让队列凭空消失
export function adoptGuestQueue(guestToken, userId) {
    if (!guestToken || !userId) return 0;
    const db = store.getDb();
    const from = db.queues['s:' + guestToken];
    if (!from || !from.items.length) return 0;
    const to = getQueueFor('u:' + userId);
    if (to.items.length) return 0; // 目标队列已有内容就不覆盖
    db.queues['u:' + userId] = from;
    delete db.queues['s:' + guestToken];
    return from.items.length;
}

// ---------- 歌单权限 ----------
// 歌单只有主人能改（§5.1），但**管理员名下的歌单所有人可读可听**：
// 房主整理的歌单相当于给群里用的公共电台（2026/10/15 用户决定）。
function adminIds() {
    return new Set(store.getDb().users.filter((u) => u.role === 'admin').map((u) => u.id));
}

// 只管读：主人自己，或管理员名下的歌单
function findReadablePlaylist(id, auth) {
    const db = store.getDb();
    if (!id) fail(400, '缺少歌单 id');
    const pl = db.playlists.find((p) => p.id === id);
    if (!pl) fail(404, '歌单不存在');
    const mine = !!(auth?.userId && pl.ownerId === auth.userId);
    const shared = !!(pl.ownerId && adminIds().has(pl.ownerId));
    // 既不是我的、也不是管理员公开的 → 当成不存在，不泄露它是否存在
    if (!mine && !shared) fail(404, '歌单不存在');
    return { pl, canEdit: mine };
}

// 改歌单：只有主人
function findOwnPlaylist(id, auth) {
    const userId = requireUser(auth);
    const { pl } = findReadablePlaylist(id, auth);
    if (pl.ownerId !== userId) fail(404, '歌单不存在');
    return pl;
}

function findIn(arr, itemId, label = '条目不存在') {
    const i = arr.findIndex((x) => x.id === itemId);
    if (i < 0) fail(404, label);
    return i;
}

function moveItem(arr, itemId, toIndex) {
    if (!Number.isInteger(toIndex) || toIndex < 0) fail(400, 'toIndex 不合法');
    const from = findIn(arr, itemId);
    if (toIndex > arr.length - 1) fail(400, 'toIndex 不合法');
    const [item] = arr.splice(from, 1);
    arr.splice(toIndex, 0, item);
}

// 歌单主人的展示名：用昵称，没设昵称才退回用户名
function ownerNameOf(ownerId) {
    if (!ownerId) return null;
    const u = store.getDb().users.find((x) => x.id === ownerId);
    return u ? u.displayName || u.username : null;
}

function summarizePlaylists(arr) {
    return arr.map((p) => ({
        id: p.id,
        name: p.name,
        count: p.items?.length ?? 0,
        // 侧栏列表要显示封面图（照用户给的稿子），歌单本身没存封面，
        // 就拿第一首的封面当歌单封面
        cover: p.items?.[0]?.cover || '',
        ownerId: p.ownerId,
        ownerName: ownerNameOf(p.ownerId),
        createdAt: p.createdAt ?? p.items?.[0]?.addedAt ?? null,
    }));
}

export function list(auth) {
    const db = store.getDb();
    const ownerId = auth?.userId ?? null;
    const mine = ownerId ? db.playlists.filter((p) => p.ownerId === ownerId) : [];
    // "大家的歌单"：管理员名下的、且不是我自己建的
    const admins = adminIds();
    const shared = db.playlists.filter((p) => p.ownerId && p.ownerId !== ownerId && admins.has(p.ownerId));
    const queue = auth?.userId || auth?.token ? myQueue(auth) : emptyQueue();
    return {
        playlists: summarizePlaylists(mine),
        shared: summarizePlaylists(shared),
        queue,
    };
}

export function getPlaylist(id, auth) {
    const { pl, canEdit } = findReadablePlaylist(id, auth);
    return {
        id: pl.id,
        name: pl.name,
        items: pl.items,
        ownerId: pl.ownerId,
        ownerName: ownerNameOf(pl.ownerId),
        canEdit,
        // 歌单本身没存封面，拿第一首的封面当封面（侧栏和歌单页头都用它）
        cover: pl.items?.[0]?.cover || '',
        // 建单时间。早期建的歌单没有这个字段（那时候没存），
        // 退回"最早加进来的那首"的时间 —— 导入出来的歌单是同一批加的，等效
        createdAt: pl.createdAt ?? pl.items?.[0]?.addedAt ?? null,
    };
}

export function createPlaylist({ name } = {}, auth) {
    const db = store.getDb();
    const userId = requireUser(auth);
    const pl = { id: store.nextId(), ownerId: userId, name: requireName(name), items: [], createdAt: Date.now() };
    db.playlists.push(pl);
    store.save();
    return { id: pl.id, name: pl.name, items: pl.items };
}

// 导入一个歌单（内容由调用方准备好，比如从 B 站收藏夹抓来的）。
// 和普通"加歌"不同：**cid 允许为空**。4000 首的收藏夹逐首查 cid 要 4000 次请求，
// 不现实；所以先只存 bvid 和标题，播到那首时 /api/audio 再补（补完会回写，见 backfillCid）。
export function importPlaylist({ name, items } = {}, auth) {
    const db = store.getDb();
    const userId = requireUser(auth);
    const pl = { id: store.nextId(), ownerId: userId, name: requireName(name), items: [], createdAt: Date.now() };
    const seen = new Set();
    for (const it of items || []) {
        if (pl.items.length >= PLAYLIST_MAX) break;
        const bvid = String(it?.bvid ?? '').trim();
        if (!bvid || seen.has(bvid)) continue; // 收藏夹里同一首可能出现多次，去重
        seen.add(bvid);
        pl.items.push({
            id: store.nextId(),
            bvid,
            cid: String(it.cid ?? ''),
            title: String(it.title ?? ''),
            // up 主名：收藏夹接口本来就返回，顺手存下来，播放条要显示
            author: String(it.author ?? ''),
            cover: String(it.cover ?? ''),
            duration: Number(it.duration) || 0,
            addedAt: Date.now(),
        });
    }
    if (!pl.items.length) fail(400, '没有可导入的内容');
    db.playlists.push(pl);
    store.save();
    return { id: pl.id, name: pl.name, count: pl.items.length };
}

// 惰性查到的 cid / up 主名回写进歌单和队列里 ——
// 这样同一首歌**一辈子只查一次**，不是每次播放都查（用户特意问过这点）
export function backfillTrack(bvid, { cid, author } = {}) {
    if (!bvid || (!cid && !author)) return 0;
    const db = store.getDb();
    let n = 0;
    const fix = (it) => {
        if (it.bvid !== bvid) return;
        if (cid && !it.cid) { it.cid = String(cid); n++; }
        if (author && !it.author) { it.author = String(author); n++; }
    };
    for (const pl of db.playlists) for (const it of pl.items) fix(it);
    for (const q of Object.values(db.queues || {})) for (const it of q?.items || []) fix(it);
    if (n) store.save();
    return n;
}
// 老名字（只补 cid 的那批调用方）
export const backfillCid = (bvid, cid) => backfillTrack(bvid, { cid });

export function renamePlaylist(id, { name } = {}, auth) {
    const pl = findOwnPlaylist(id, auth);
    pl.name = requireName(name);
    store.save();
    return { id: pl.id, name: pl.name, items: pl.items };
}

export function deletePlaylist(id, auth) {
    const db = store.getDb();
    const pl = findOwnPlaylist(id, auth);
    db.playlists = db.playlists.filter((p) => p.id !== pl.id);
    store.save();
    return { ok: true };
}

export function addToPlaylist(id, body = {}, auth) {
    const pl = findOwnPlaylist(id, auth);
    const t = requireTrack(body);
    // 歌单里也不允许出现重复的同一首
    const dup = pl.items.find((x) => x.bvid === t.bvid && x.cid === t.cid);
    if (dup) {
        store.save();
        return { duplicate: true, item: dup, playlist: getPlaylist(id, auth) };
    }
    if (pl.items.length >= PLAYLIST_MAX) fail(400, '单个歌单最多 ' + PLAYLIST_MAX + ' 首');
    const item = makeItem(body);
    const at = body.at;
    if (at == null) {
        pl.items.push(item);
    } else {
        if (!Number.isInteger(at) || at < 0 || at > pl.items.length) fail(400, 'at 不合法');
        pl.items.splice(at, 0, item);
    }
    store.save();
    return { item, playlist: getPlaylist(id, auth) };
}

export function removeFromPlaylist(id, itemId, auth) {
    const pl = findOwnPlaylist(id, auth);
    const i = findIn(pl.items, itemId);
    pl.items.splice(i, 1);
    store.save();
    return getPlaylist(id, auth);
}

export function moveInPlaylist(id, { itemId, toIndex } = {}, auth) {
    if (!itemId) fail(400, '缺少 itemId');
    const pl = findOwnPlaylist(id, auth);
    moveItem(pl.items, itemId, toIndex);
    store.save();
    return getPlaylist(id, auth);
}

export function playPlaylist(id, auth) {
    // 只要有读权限就能播 —— 反正进的是"我自己"的队列，冲不到别人
    const { pl } = findReadablePlaylist(id, auth);
    const q = myQueue(auth);
    q.items = pl.items.map((it) => ({
        id: store.nextId(),
        bvid: it.bvid,
        cid: it.cid,
        title: it.title,
        cover: it.cover,
        duration: it.duration,
        addedAt: Date.now(),
    }));
    q.currentId = q.items[0]?.id ?? null;
    store.save();
    return q;
}

export function getQueue(auth) {
    return myQueue(auth);
}

export function queueAdd(body = {}, auth) {
    const q = myQueue(auth);
    const items = q.items;
    const t = requireTrack(body);
    // 同一首（bvid+cid）已经在队列里就不再追加一份，避免"一直点一直加"
    const dup = items.find((x) => x.bvid === t.bvid && x.cid === t.cid);
    if (dup) {
        let moved = false;
        if (body.next && items.length > 1) {
            // next:true 的语义 = 排在下一位，所以是"挪过去"而不是"再加一份"
            items.splice(items.indexOf(dup), 1);
            const idx = items.findIndex((x) => x.id === q.currentId);
            items.splice(idx < 0 ? items.length : idx + 1, 0, dup);
            moved = true;
        }
        store.save();
        return { ...q, duplicate: true, moved };
    }
    const item = makeItem(body);
    if (!items.length) {
        items.push(item);
        q.currentId = item.id;
    } else if (body.next) {
        const idx = items.findIndex((x) => x.id === q.currentId);
        const insertAt = idx < 0 ? items.length : idx + 1;
        items.splice(insertAt, 0, item);
    } else {
        items.push(item);
    }
    store.save();
    return q;
}

export function queueRemove(itemId, auth) {
    const q = myQueue(auth);
    const items = q.items;
    const i = findIn(items, itemId);
    const wasCurrent = q.currentId === itemId;
    items.splice(i, 1);
    if (wasCurrent) q.currentId = items[0]?.id ?? null;
    store.save();
    return q;
}

export function queueMove({ itemId, toIndex } = {}, auth) {
    if (!itemId) fail(400, '缺少 itemId');
    const q = myQueue(auth);
    moveItem(q.items, itemId, toIndex);
    store.save();
    return q;
}

export function queueClear(auth) {
    const q = myQueue(auth);
    q.items = [];
    q.currentId = null;
    store.save();
    return q;
}

export function queueCurrent(itemId, auth) {
    const q = myQueue(auth);
    findIn(q.items, itemId);
    q.currentId = itemId;
    store.save();
    return q;
}

export function queueMode({ mode } = {}, auth) {
    if (!MODES.has(mode)) fail(400, 'mode 不合法');
    const q = myQueue(auth);
    q.mode = mode;
    store.save();
    return q;
}

export function queueAdvance({ dir } = {}, auth) {
    const q = myQueue(auth);
    const items = q.items;
    if (!items.length) {
        q.currentId = null;
        store.save();
        return { queue: q, currentId: null, ended: true };
    }
    let idx = items.findIndex((x) => x.id === q.currentId);
    if (idx < 0) idx = 0;
    const prev = dir === 'prev';

    if (q.mode === 'loop-one') {
        q.currentId = items[idx].id;
        store.save();
        return { queue: q, currentId: q.currentId, ended: false };
    }

    if (q.mode === 'shuffle') {
        if (items.length === 1) {
            q.currentId = items[0].id;
        } else {
            let n = idx;
            while (n === idx) n = Math.floor(Math.random() * items.length);
            q.currentId = items[n].id;
        }
        store.save();
        return { queue: q, currentId: q.currentId, ended: false };
    }

    if (q.mode === 'loop-all') {
        const n = prev
            ? (idx - 1 + items.length) % items.length
            : (idx + 1) % items.length;
        q.currentId = items[n].id;
        store.save();
        return { queue: q, currentId: q.currentId, ended: false };
    }

    if (prev) {
        if (idx <= 0) return { queue: q, currentId: q.currentId, ended: true };
        q.currentId = items[idx - 1].id;
        store.save();
        return { queue: q, currentId: q.currentId, ended: false };
    }
    if (idx >= items.length - 1) {
        return { queue: q, currentId: q.currentId, ended: true };
    }
    q.currentId = items[idx + 1].id;
    store.save();
    return { queue: q, currentId: q.currentId, ended: false };
}
