// 账户 / 会话 / 邀请码：整个项目只有这个文件知道密码怎么存、令牌怎么发。
// 安全约定（§七）：不用 bcrypt、不手写 JWT、日志里永远不出现 token / 密码。
import crypto from 'node:crypto';
import * as store from './store.js';

const KEYLEN = 64; // scrypt 输出长度（字节）
const SALT_BYTES = 16;
const SESSION_TTL = 365 * 24 * 3600e3; // 令牌有效期：1 年（**滑动续期**，见 touchSession）
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

function fail(status, message) {
    const e = new Error(message);
    e.status = status;
    throw e;
}

// ---------- 密码：crypto.scrypt，绝不自己发明哈希 ----------
export function hashPassword(password, salt = crypto.randomBytes(SALT_BYTES).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
    return { salt, hash };
}

function verifyPassword(password, salt, hash) {
    let want;
    try {
        want = Buffer.from(String(hash), 'hex');
    } catch {
        return false;
    }
    if (want.length !== KEYLEN) return false;
    const got = crypto.scryptSync(password, salt, KEYLEN);
    return crypto.timingSafeEqual(got, want); // 定长比较，避免时序侧信道
}

function requireUsername(name) {
    const n = String(name ?? '').trim();
    if (!USERNAME_RE.test(n)) fail(400, '用户名要 3-20 位，只能用字母、数字、下划线、连字符');
    return n;
}

// 密码**不做长度限制**（2026/10/15 用户要求，原来是 8-200 位）。
// 只拒绝空密码：否则知道用户名就能空密码登进来，等于这个账号没有意义。
// 想连空密码也放行的话，把下面这个 if 删掉即可 —— 但那样任何知道用户名的人都能进来。
function requirePassword(pw) {
    const p = String(pw ?? '');
    if (!p) fail(400, '密码不能为空');
    return p;
}

// 对外永远用这个，绝不外传 passwordHash / salt
export function publicUser(u) {
    if (!u) return null;
    return {
        id: u.id,
        username: u.username,
        displayName: u.displayName ?? null, // 原始值，可能为 null；展示用 displayNameOf()
        role: u.role,
        status: u.status,
        createdAt: u.createdAt,
    };
}

// 昵称是"展示名"，和账号（username）分开。
// 没设昵称就退回用户名，所以展示处一律用这个，不要直接读 u.username。
export function displayNameOf(u) {
    if (!u) return '';
    return u.displayName || u.username;
}

// 昵称：可选，允许中文，最长 20 字。空字符串 = 清掉昵称（退回用户名）
function normalizeDisplayName(dn) {
    if (dn == null) return null;
    const s = String(dn).trim();
    if (!s) return null;
    if (s.length > 20) fail(400, '昵称最长 20 个字');
    return s;
}

// ---------- 用户 ----------
export function findUserByName(username) {
    const n = String(username ?? '').trim().toLowerCase();
    if (!n) return null;
    return store.getDb().users.find((x) => String(x.username).toLowerCase() === n) || null;
}

export function findUserById(id) {
    if (!id) return null;
    return store.getDb().users.find((x) => x.id === id) || null;
}

export function countUsers() {
    return store.getDb().users.length;
}

export function createUser({ username, displayName = null, password, role = 'user', status = 'active' }) {
    const name = requireUsername(username);
    if (findUserByName(name)) fail(409, '用户名已被占用');
    const pw = requirePassword(password);
    const { salt, hash } = hashPassword(pw);
    const user = {
        id: store.nextId('u'),
        username: name,
        displayName: normalizeDisplayName(displayName),
        passwordHash: hash,
        salt,
        role,
        status,
        createdAt: Date.now(),
    };
    store.getDb().users.push(user);
    return user;
}

// 改昵称（不是改账号）。空值 = 清掉昵称，展示时退回用户名。
export function changeDisplayName(userId, displayName) {
    const u = findUserById(userId);
    if (!u) fail(404, '用户不存在');
    u.displayName = normalizeDisplayName(displayName);
    return u;
}

// 改密码 → 该用户所有旧令牌立即失效（§六 M3）
export function changePassword(userId, newPassword) {
    const u = findUserById(userId);
    if (!u) fail(404, '用户不存在');
    const { salt, hash } = hashPassword(requirePassword(newPassword));
    u.salt = salt;
    u.passwordHash = hash;
    const killed = deleteSessionsOf(u.id);
    return { user: u, killedSessions: killed };
}

// ---------- 会话：随机不透明令牌，存表校验（不手写 JWT） ----------
// 注意区分两个东西：
//   token = 凭据，只能放在 Authorization 头里，绝不能出现在给别人的数据中
//   sid   = 公开标识，用来在房间里表示"你是谁"（房主/成员/谁加的曲子），泄露也没用
export function createSession(userId = null) {
    pruneSessions();
    const now = Date.now();
    const s = {
        token: crypto.randomBytes(32).toString('base64url'),
        sid: crypto.randomBytes(9).toString('base64url'),
        userId: userId ?? null,
        createdAt: now,
        expiresAt: now + SESSION_TTL,
    };
    store.getDb().sessions.push(s);
    return s;
}

// 维护 sessions：清掉过期的；顺带按"闲置"清掉**游客**会话（2026/10/16 用户要求
// "定期清理游客账号数据"）。
//
// 为什么单给游客一条闲置规则：每个没登录的浏览器都会领一个游客身份 ✓
// 实测上线一天就攒了 67 个 ✗（绝大多数是"路过看一眼"留下的空队列）。
// 登录用户的会话**不按闲置清**（30 天绝对有效期，照旧）—— 不能被"几天没上"踢下线。
//
// ⚠️ 判据抽成纯函数 shouldPruneGuestSession()，这样能离线测（见 check-invite.mjs）。
// 用户 2026/10/16 定的规则：**所有游客一律 7 天没上线就清**（不分有没有歌）——
// 原来我按"空队列 7 天 / 有歌 30 天"分了两档，用户明确改成一律 7 天。
export const GUEST_IDLE = 7 * 24 * 3600e3;
export const SEEN_TOUCH_MS = 6 * 3600e3; // 活跃时间最多 6 小时写一次盘（够用且不吵）

// 纯函数：这个（游客）会话该不该因为闲置被清掉
//   session.lastSeenAt 没有就退回 createdAt（老数据没有这个字段）
export function shouldPruneGuestSession(session, queue, now = Date.now()) {
    if (!session || session.userId) return false; // 登录用户不管
    const last = Number(session.lastSeenAt) || Number(session.createdAt) || now;
    return now - last > GUEST_IDLE;
}

export function pruneSessions() {
    const db = store.getDb();
    const now = Date.now();
    const kept = db.sessions.filter((s) => s && typeof s.expiresAt === 'number' && s.expiresAt > now);
    const removed = db.sessions.length - kept.length;
    if (removed) db.sessions = kept;
    for (const s of db.sessions) {
        if (!s.sid) s.sid = crypto.randomBytes(9).toString('base64url');
    }
    // 再按闲置清一遍游客（队列有没有歌决定宽限期）
    const alive = db.sessions.filter((s) => !shouldPruneGuestSession(s, db.queues['s:' + s.token], now));
    const idleRemoved = db.sessions.length - alive.length;
    if (idleRemoved) db.sessions = alive;
    return removed + idleRemoved;
}

// 记一句"这个人还在用"，顺手把登录用户的令牌**续期**。
// 用户 2026/10/17：「就不能一直保持登陆么，我觉得这样再登录会很麻烦，
// 而且我网站用的人不多」⇒ 改成**滑动续期**：
//   登录用户每次访问都把有效期往后推到"现在 + 1 年"⇒ 只要还在用就**永远不过期** ✓
//   彻底不用了（一年没碰）才会失效 ✓ —— 比"30 天到了重新登录"体验好得多，
//   又不像"永不过期"那样给泄露的令牌留一个永久后门。
// ⚠️ 必须节流：这条路每个请求都会走到，每次都写盘会把 db.json 写爆 ✗
//    （有效期还剩 364 天以上就不用再推了 ⇒ 每个活跃用户每天最多写一次 ✓）
// ⚠️ 游客**不续期**：他们有 7 天没上线就清的规则（用户自己定的 ✓），
//    给他们续期等于那条规则永远不生效 ✗
export function touchSession(s) {
    if (!s) return;
    const now = Date.now();
    if (s.userId) {
        if (typeof s.expiresAt === 'number' && s.expiresAt - now > SESSION_TTL - 86400e3) return;
        s.expiresAt = now + SESSION_TTL;
        store.save();
        return;
    }
    if (Number(s.lastSeenAt) && now - Number(s.lastSeenAt) < SEEN_TOUCH_MS) return;
    s.lastSeenAt = now;
    store.save();
}

export function getSession(token) {
    if (!token) return null;
    const s = store.getDb().sessions.find((x) => x.token === token);
    if (!s) return null;
    if (typeof s.expiresAt !== 'number' || s.expiresAt <= Date.now()) return null;
    // 记一句"还在用"（游客闲置清理要用；内部有 6 小时节流，别担心写盘）
    touchSession(s);
    return s;
}

export function deleteSession(token) {
    const db = store.getDb();
    const before = db.sessions.length;
    db.sessions = db.sessions.filter((x) => x.token !== token);
    return db.sessions.length !== before;
}

export function deleteSessionsOf(userId) {
    const db = store.getDb();
    const before = db.sessions.length;
    db.sessions = db.sessions.filter((x) => x.userId !== userId);
    return before - db.sessions.length;
}

// ---------- 注册 / 登录 / 登出 ----------
export function login({ username, password }) {
    const u = findUserByName(username);
    // 用户不存在时也照样跑一次 scrypt，避免用响应快慢探测用户名是否存在
    const salt = u ? u.salt : '0'.repeat(SALT_BYTES * 2);
    const hash = u ? u.passwordHash : '0'.repeat(KEYLEN * 2);
    const ok = verifyPassword(String(password ?? ''), salt, hash);
    if (!u || !ok) fail(401, '用户名或密码不对');
    if (u.status !== 'active') fail(403, '账号未启用');
    const s = createSession(u.id);
    return { user: publicUser(u), token: s.token, expiresAt: s.expiresAt };
}

export function register({ username, displayName, password, inviteCode }) {
    const db = store.getDb();
    const code = String(inviteCode ?? '').trim();
    if (!code) fail(400, '缺少邀请码');
    const inv = db.invites.find((x) => x.code === code);
    if (!inv) fail(403, '邀请码无效');
    if (inv.revokedAt) fail(403, '邀请码已被吊销');
    if (inv.usedBy) fail(403, '邀请码已被使用');
    if (inv.expiresAt && inv.expiresAt <= Date.now()) fail(403, '邀请码已过期');
    // 先建用户：用户名/密码不合格会抛错，此时邀请码还没被消耗，朋友可以重试
    const user = createUser({ username, displayName, password, role: 'user', status: 'active' });
    // ⚠️ 邀请码用掉就**直接删掉**（用户 2026/10/16："邀请码使用过的自动删除就行了"）。
    //    一次性的东西留着只会让列表越来越长，"已使用"这个状态本身也没意义了。
    //    删它**不会影响已注册用户**：用户是 db.users 里独立的一条记录，
    //    inv.usedBy 只是"谁用了它"的备注，没有任何逻辑反过来靠它找用户
    //    （scripts/check-invite.mjs 专门验这条：删完之后新用户照样登录、数据还在）。
    //    注意顺序：**先建用户再删码** —— 建用户失败时邀请码还在，朋友可以重试。
    db.invites = db.invites.filter((x) => x.code !== code);
    store.save();
    const s = createSession(user.id);
    return { user: publicUser(user), token: s.token, expiresAt: s.expiresAt };
}

// 启动时清掉"以前用过但还留着"的邀请码 —— 老数据的一次性清理，
// 之后新注册的都由 register() 当场删掉。
export function pruneInvites() {
    const db = store.getDb();
    const before = db.invites.length;
    const kept = db.invites.filter((x) => !x.usedBy);
    if (kept.length === before) return 0;
    db.invites = kept;
    store.save();
    return before - kept.length;
}

// ---------- 邀请码 ----------
// 去掉容易看错的 I O 0 1，避免口头/手抄传递时出错
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createInvite({ createdBy = null, expiresInDays = null } = {}) {
    const db = store.getDb();
    let code;
    do {
        code = [...crypto.randomBytes(10)]
            .map((b) => ALPHABET[b % ALPHABET.length])
            .join('');
    } while (db.invites.some((x) => x.code === code));
    const days = Number(expiresInDays);
    const inv = {
        code,
        createdBy,
        createdAt: Date.now(),
        expiresAt: days > 0 ? Date.now() + days * 86400e3 : null,
        usedBy: null,
        usedAt: null,
        revokedAt: null,
    };
    db.invites.push(inv);
    return inv;
}

export function inviteStatus(inv) {
    if (inv.revokedAt) return 'revoked';
    if (inv.usedBy) return 'used';
    if (inv.expiresAt && inv.expiresAt <= Date.now()) return 'expired';
    return 'unused';
}

export function listInvites() {
    return store.getDb().invites.map((x) => ({ ...x, status: inviteStatus(x) }));
}

export function revokeInvite(code) {
    const inv = store.getDb().invites.find((x) => x.code === String(code ?? '').trim());
    if (!inv) fail(404, '邀请码不存在');
    if (inv.usedBy) fail(409, '邀请码已被使用，吊销它没有意义');
    if (inv.revokedAt) fail(409, '邀请码早就吊销了');
    inv.revokedAt = Date.now();
    return inv;
}
