// 条目校验：**只有这一份**。
//
// 为什么单独抽出来：api.js 和 rooms.js 原来各有一份 requireTrack，内容几乎一样。
// 2026/10/15 我放宽了 rooms.js 那份（cid 允许为空），**忘了 api.js 那份** ——
// 结果房间队列能加、自己的队列加不了：
//   POST /api/queue/items 带空 cid → 400 缺少 cid
// 而导入的歌单条目**就是没有 cid**（播到那首才补），所以现象是
//   "播过的歌（cid 回写进去了）能播，没播过的点播放没反应"
// —— 用户朋友报的"双击和点播放都有概率没用"就是这个。
// 两份平行实现必然再次跑偏，所以合并。

function fail(status, message) {
    const e = new Error(message);
    e.status = status;
    throw e;
}

// 单个歌单的上限。B 站自己也这样：只有默认收藏夹能超过 1000，别的都是上限 1000。
// ⚠️ **只在这里定义一份** —— 原来 api.js / index.js 各写了一个 1000
//（还有 rooms.js 那个"一次最多加 200 首"的随手限制，比歌单上限还小，
//  结果房间里点【播放全部】直接被挡）。同一个数字散在多处，迟早对不上。
export const PLAYLIST_MAX = 1000;

// 一次批量加队列的上限。和歌单上限对齐：**至少要能一次加完一个满歌单**，
// 否则"播放全部"这种功能必然撞墙（2026/10/15 用户报的就是这个）。
export const BATCH_MAX = PLAYLIST_MAX;

// cid **允许为空**，bvid 必需。
// rooms.js 和 api.js 的语义已经完全一致（都是"播到再补 cid"），所以共用一份。
export function requireTrack(body) {
    if (!body || typeof body !== 'object') fail(400, '缺少参数');
    if (body.bvid == null || body.bvid === '') fail(400, '缺少 bvid');
    return {
        bvid: String(body.bvid),
        cid: body.cid == null ? '' : String(body.cid),
        title: body.title == null ? '' : String(body.title),
        // up 主名：播放条标题下面那行显示它（原来那里是调试用的码率）
        author: body.author == null ? '' : String(body.author),
        cover: body.cover == null ? '' : String(body.cover),
        duration: Number(body.duration) || 0,
    };
}
