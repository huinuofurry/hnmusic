// 上线前的"现场检查"：一边核对线上到底生效了哪些东西，一边看有没有人在房间里
// （有人的话重启会把房间清掉，得先问一声）。
//
// 用法：node scripts/check-live.mjs
//
// 说明：这里查的是**部署状态**，不是代码正确性 —— 代码正确性由
// check-frontend / check-bili / check-track / check-offline-grace 那几套管。
import { readFileSync } from 'node:fs';

const SRV = process.env.HN_SRV || 'http://124.220.169.253:8443';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (c, label, extra) => {
    if (c) {
        pass++;
        console.log('  OK   ' + label);
    } else {
        fail++;
        console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
    }
};

// 前端标记：每加一个用户可见的功能，往这里补一条。
// ⚠️ 查"某句话还在不在"时别用裸字符串 —— 注释里引用过同一句话就会假红
//    （2026/10/15 踩过），要查代码形状。
const MARKERS = [
    ['id="btn-mode"', '播放模式图标按钮'],
    ['user-select:all', '歌名点一下全选'],
    ['id="np-author"', '播放条 up 主名'],
    ['function findPlItem', '点行不重拉整个歌单'],
    ['withCoverSize', '封面缩放'],
    ['function remixIcon', '图标走 Remix sprite（播放键是 SVG）'],
    ['function refetchAudio', '取流地址过期自愈'],
    ['#np-right { display:flex', '播放条右侧那组靠右留白'],
    ['li.offline', '成员列表"离线"样式'],
    ['id="btn-rehome"', '管理员【刷新收藏夹】'],
    ['function isAdmin()', '全局 isAdmin()'],
    ['function leaveRoomLocally', '房间没了会本地退出（不再无限重连）'],
    ['r.status === 404', 'SSE 遇到 404 会停下（服务重启清空房间后别再刷）'],
    ['设为房主', '管理员能改房主（成员列表里的入口）'],
    ['const alignQueue', '房间里按 ▶ 会切到房间当前那首 + 把队列滚到那一项'],
    ['function forgetRoom', '刷新后自动回房（记得住上次的房间）'],
    ['onRoomTrack', '播放条上那首对不上房间当前项时会先切过去'],
    ['function preloadNextInRoom', '一起听预热下一首（单人不预热）'],
    ['audioUrlCache', '播放时复用预热过的 URL（否则预热白下）'],
    ['function applyQueueDelta', '队列事件按**增量**应用（不再整份重发）'],
    // 2026/10/19：重写版把这几条保护弄丢过，补回来之后要盯住别再丢
    ['let lastStreamAt = 0;', '事件流看门狗（半开连接自己重连 + 补拉状态）'],
    ['markUser(true)', '令牌失效不静默降级成游客'],
    ['pauseLockUntil = Date.now() + 1500;', '按暂停只锁进度（不吞广播）'],
    ['a.currentTime = pos;', '房间里拖进度条本地先跳'],
    ['const HOME_CARDS', '首页卡片 = 收藏夹最新几首'],
    ['/api/home', '首页一次拿两批数据（/api/home）'],
];

console.log('线上: ' + SRV);
console.log('');
console.log('健康 / 前端标记：');
let html = '';
try {
    const h = await (await fetch(SRV + '/api/health')).json();
    ok(h && h.ok === true, '/api/health 正常', h);
    html = await (await fetch(SRV + '/')).text();
} catch (e) {
    fail++;
    console.log('  FAIL 连不上: ' + e.message);
}
for (const [needle, label] of MARKERS) ok(html.includes(needle), label);

console.log('');
console.log('后端行为：');
try {
    const guest = (await (await fetch(SRV + '/api/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).token;
    const r = await fetch(SRV + '/api/bili/fav-preview?user=' + encodeURIComponent('灰诺-') + '&limit=3&fresh=1', { headers: { Authorization: 'Bearer ' + guest } });
    ok(r.status === 403, '收藏夹强制刷新只给管理员（游客 403）', r.status);
    // 2026/10/19：首页新接口 /api/home（cards = 最新收藏，items = 每日精选）
    const bad = await fetch(SRV + '/api/home');
    ok(bad.status === 400, '/api/home 缺 user 时 400', bad.status);
    const g2 = await fetch(SRV + '/api/home?user=' + encodeURIComponent('灰诺-') + '&fresh=1', { headers: { Authorization: 'Bearer ' + guest } });
    ok(g2.status === 403, '/api/home 的 fresh 也只给管理员（游客 403）', g2.status);
    const h = await (await fetch(SRV + '/api/home?user=' + encodeURIComponent('灰诺-') + '&limit=20&cards=6')).json();
    ok(h && Array.isArray(h.cards) && h.cards.length === 6, '/api/home 返回 6 张卡片', h && h.cards && h.cards.length);
    ok(h && Array.isArray(h.items) && h.items.length > 0, '/api/home 返回每日精选列表', h && h.items && h.items.length);
    ok(!!(h && h.user && h.folder && h.daily), '/api/home 带回 user / folder / daily');
} catch (e) {
    fail++;
    console.log('  FAIL 后端检查出错: ' + e.message);
}

// 有没有人在房间里 —— 重启会清掉房间，这个信息决定"能不能现在重启"
console.log('');
console.log('房间里有没有人（决定能不能安全重启）：');
try {
    const admin = (await (await fetch(SRV + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.HN_ADMIN_USER || 'huinuo', password: process.env.HN_ADMIN_PASS || '258015124' }) })).json()).token;
    if (!admin) {
        console.log('  ?  登录失败，跳过（要看房间请设 HN_ADMIN_USER / HN_ADMIN_PASS）');
    } else {
        // ⚠️ 房间不在 /api/state 里，是单独的 /api/rooms（每条带 members 人数）。
        //    但那个人数**包含宽限期内的离线者** —— 光看它会把"人都走光只剩离线标记"
        //    的房间也算成有人在听（我第一次就是这么误报的）。
        //    所以逐间拉详情，只数 `!offline` 的人。
        const rl = await (await fetch(SRV + '/api/rooms', { headers: { Authorization: 'Bearer ' + admin } })).json();
        const rooms = rl.rooms || [];
        const busy = [];
        for (const r of rooms) {
            const d = await (await fetch(SRV + '/api/rooms/' + r.roomId, { headers: { Authorization: 'Bearer ' + admin } })).json();
            const online = (d.members || []).filter((m) => !m.offline);
            if (online.length) busy.push({ name: r.name, n: online.length });
        }
        if (!rooms.length) console.log('  没有房间 ✓ 重启安全');
        else if (!busy.length) console.log('  有 ' + rooms.length + ' 个房间，但**在线的人为 0** ✓ 重启安全');
        else {
            console.log('  ⚠️  有 ' + busy.length + ' 个房间**有人正在听**：');
            for (const b of busy) console.log('       ' + b.name + '  (' + b.n + ' 人在线)');
            console.log('      重启会把他们踢出去并清空房间 —— 先问一声');
        }
    }
} catch (e) {
    console.log('  ?  房间检查跳过: ' + e.message);
}

// 房间短链接 /r/<token> 要能被当成首页发出来（不是 404）
try {
    const r = await fetch(SRV + '/r/abcdefghijkl');
    const text = await r.text();
    if (r.status === 200 && text.includes('id="list"')) ok(true, '房间短链接 /r/<token> 会当成首页发（不是 404）');
    else fail('/r/<token> 没被当成首页（状态 ' + r.status + '）');
} catch (e) {
    fail('/r/<token> 请求失败：' + e.message);
}

console.log('');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
