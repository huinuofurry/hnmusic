// 存储层：整个项目只有这个文件碰 data/db.json。
// 单进程串行写入，所以不需要任何锁 —— 但**必须真的是单进程**，见下面的 takeLock()。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 数据目录默认是 <项目>/data。
// `HN_DATA_DIR` 可以覆盖 —— 给**测试**用（测试要起一个自己的服务实例，
// 既不能碰开发用的 data/db.json，也不能和正在跑的那个进程抢单实例锁），
// 也让"同一台机器上跑两份"成为可能（各自的库互不干扰）。
const DIR = process.env.HN_DATA_DIR
    ? path.resolve(process.env.HN_DATA_DIR)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DIR, 'db.json');
const TMP = path.join(DIR, 'db.json.tmp');
const LOCK = path.join(DIR, '.lock');

// ---------- 单实例锁（2026/10/15 加）----------
// db.json 是"整份读进内存、整份写回磁盘"的，所以**两个进程同时用同一份库
// 必然互相覆盖**。§8.5 那次丢数据就是这个根因（CLI 和服务同时在写）。
// 所以启动时占一个 PID 锁：已经有人在跑就直接拒绝启动，并告诉用户先停掉谁。
// 陈旧锁（进程已经不在了）会被自动接管。
function takeLock() {
    let raw = '';
    try {
        raw = fs.readFileSync(LOCK, 'utf8').trim();
    } catch {
        /* 没有锁文件，正常 */
    }
    const pid = Number(raw);
    if (pid && pid !== process.pid) {
        let alive = false;
        try {
            process.kill(pid, 0); // 只探测，不发信号
            alive = true;
        } catch (e) {
            alive = e.code !== 'ESRCH'; // ESRCH = 进程没了；其它错误保守当作还在
        }
        if (alive) {
            throw new Error(
                '已经有一个 hnmusic 在用它了（PID ' + pid + '）。\n' +
                    '两个进程同时写会互相覆盖、丢数据，所以这里拒绝启动。\n' +
                    '先停掉那个：systemctl stop hnmusic   或   kill ' + pid
            );
        }
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(LOCK, String(process.pid));
}
function releaseLock() {
    try {
        if (fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK);
    } catch {
        /* 锁已经没了就无所谓 */
    }
}

function emptyDb() {
    return {
        seq: 1,
        playlists: [],
        users: [],
        sessions: [],
        rooms: [],
        // §5.2 的 schema 里没有 invites，但 M3 的邀请制必须存邀请码，这是必要的扩展
        invites: [],
        // 队列每人一份（§5.1：队列归属"房间"，非房间时每个人就是自己的房主）。
        // 键：'u:<userId>' 登录用户 / 's:<token>' 游客会话 / 'r:<roomId>' 房间（M4）
        queues: {},
        // 2026/10/17 P1：每个用户各自登录的 B站 cookie（普通用户导入自己收藏夹用）
        // 键：'u:<userId>' / 's:<token>'（游客也能登录 B站 导入 ✓）
        biliCookies: {},
    };
}

let db = emptyDb();
let timer = null;
// 没调用过 load() 之前，绝不允许写盘。
// 否则进程退出时的 flush() 会把内存里那份默认空结构覆盖到真实数据上。
let loaded = false;

function writeNow() {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(TMP, JSON.stringify(db, null, 2));
    try {
        fs.renameSync(TMP, FILE);
    } catch {
        if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
        fs.renameSync(TMP, FILE);
    }
}

export function getDb() {
    return db;
}

// prefix 用来区分不同种类的 id（u=用户, i=歌单/条目），不传就是老行为 'i'
export function nextId(prefix = 'i') {
    const id = prefix + db.seq;
    db.seq += 1;
    return id;
}

export function load() {
    takeLock(); // 已经有人在用这份库就直接抛错，别进去互相覆盖
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILE)) {
        db = emptyDb();
        loaded = true;
        writeNow();
        return db;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (!parsed || typeof parsed !== 'object') throw new Error('bad db');
        db = parsed;
        if (typeof db.seq !== 'number') db.seq = 1;
        // M2 的库只有 seq / playlists / queue，缺的键在这里补齐
        for (const k of ['playlists', 'users', 'sessions', 'rooms', 'invites']) {
            if (!Array.isArray(db[k])) db[k] = [];
        }
        // 队列：M2 只有一个全局 queue，现在每人一份，存成 map
        if (!db.queues || typeof db.queues !== 'object' || Array.isArray(db.queues)) {
            db.queues = {};
        }
        if (db.queue && typeof db.queue === 'object') {
            // 旧的全局队列保留成 'legacy'，由 admin.js init 交给第一个管理员
            if (!db.queues.legacy && Array.isArray(db.queue.items)) db.queues.legacy = db.queue;
            delete db.queue;
        }
        for (const k of Object.keys(db.queues)) {
            const q = db.queues[k];
            if (!q || typeof q !== 'object' || Array.isArray(q)) {
                delete db.queues[k];
                continue;
            }
            if (!Array.isArray(q.items)) q.items = [];
            if (!q.mode) q.mode = 'loop-all';
            if (q.currentId === undefined) q.currentId = null;
        }
        for (const p of db.playlists) {
            // M2 建的歌单没有 ownerId，补成 null（= 游客临时歌单，对任何人都不可见）
            if (!('ownerId' in p)) p.ownerId = null;
            if (!Array.isArray(p.items)) p.items = [];
        }
        loaded = true;
        return db;
    } catch {
        const bak = FILE + '.bad.' + Date.now();
        fs.renameSync(FILE, bak);
        db = emptyDb();
        loaded = true;
        writeNow();
        return db;
    }
}

export function save() {
    if (!loaded) return; // 没 load 过就没有可写的数据
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        writeNow();
    }, 200);
}

export function flush() {
    if (!loaded) return; // 同上：CLI 只打印帮助就退出时，绝不能碰 db.json
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    writeNow();
}

process.on('exit', () => {
    try {
        flush();
    } catch {
        /* ignore */
    }
    releaseLock();
});

// ⚠️⚠️ 光有 'exit' 不够：**systemd 停服务发的是 SIGTERM，而 node 默认不跑 exit 回调** ✗
//    可 save() 是 200ms 防抖的 —— 正好在这 200ms 里重启（典型场景：
//    "朋友刚点完注册、我这边就上线"），那一笔就**永远丢了** ✗
//    （2026/10/16 是 scripts/check-invite.mjs 撞出来的：注册返回 200，
//      但重启后库里既没有那个用户、邀请码也没被删 ✓ 这就是根因）
//    所以 SIGTERM / SIGINT 都要显式冲一次盘、放掉锁，再退出。
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
        try {
            flush();
        } catch {
            /* 尽力而为 */
        }
        try {
            releaseLock();
        } catch {
            /* 尽力而为 */
        }
        process.exit(0);
    });
}
