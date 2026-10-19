// 看线上现在有多少人、都在什么状态。
//
//   node scripts/who.mjs                      默认看线上
//   node scripts/who.mjs http://localhost:8080 看本地
//
// 只读，不改任何东西。需要管理员口令（和 deploy.ps1 用同一套环境变量覆盖）
//   HN_ADMIN_USER / HN_ADMIN_PASS
const SRV = process.argv[2] || process.env.HN_SRV || 'http://124.220.169.253:8443';
const USER = process.env.HN_ADMIN_USER || 'huinuo';
const PASS = process.env.HN_ADMIN_PASS || '258015124';
const OFFLINE_TTL = 60_000; // 服务端的断线宽限期（和 rooms.js 里一致）

const post = async (p, body, token) => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(SRV + p, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
    return { status: r.status, data: await r.json().catch(() => null) };
};
const get = async (p, token) => {
    const h = {};
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(SRV + p, { headers: h });
    return { status: r.status, data: await r.json().catch(() => null) };
};
const mmss = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '?';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
};

const login = await post('/api/auth/login', { username: USER, password: PASS });
if (!login.data || !login.data.token) {
    console.log('登录失败（' + (login.data && login.data.error) + '）—— 改 HN_ADMIN_USER / HN_ADMIN_PASS');
    process.exit(1);
}
const token = login.data.token;

console.log('线上: ' + SRV);
const health = await get('/api/health');
console.log('健康: ' + (health.data && health.data.ok ? '正常 ✓' : '异常 ✗') + '   已运行 ' + Math.round((health.data.uptime || 0) / 60) + ' 分钟');

const rl = await get('/api/rooms', token);
const rooms = (rl.data && rl.data.rooms) || [];
if (!rooms.length) {
    console.log('\n现在一个房间都没有 —— 没人在一起听');
    process.exit(0);
}

let totalOnline = 0;
let totalGrace = 0;
for (const r of rooms) {
    const d = (await get('/api/rooms/' + r.roomId, token)).data;
    const q = d.queue || { items: [], currentId: null };
    const idx = q.items.findIndex((x) => x.id === q.currentId);
    const cur = idx >= 0 ? q.items[idx] : null;
    // 服务端的播放位置是"锚点 + 已过去的时间"，这里按同样规则算出来
    let pos = 0;
    if (cur) {
        pos = Number(d.anchorPosition) || 0;
        if (d.isPlaying) pos += Math.max(0, (Date.now() - (Number(d.anchorServerTime) || 0)) / 1000);
    }

    console.log('');
    console.log('房间「' + d.name + '」' + (d.isPrivate ? '（私人）' : '') + '   id=' + d.roomId);
    console.log('  正在播: ' + (cur ? cur.title + (cur.author ? ' — ' + cur.author : '') : '（队列是空的）'));
    if (cur) {
        console.log(
            '          第 ' + (idx + 1) + '/' + q.items.length + ' 首   已播 ' + mmss(pos) +
                (cur.duration ? ' / ' + mmss(cur.duration) : '') +
                '   ' + (d.isPlaying ? '▶ 播放中' : '⏸ 暂停') +
                '   模式=' + (q.mode || 'sequence')
        );
    }

    const members = d.members || [];
    const online = members.filter((m) => !m.offline);
    const grace = members.filter((m) => m.offline);
    totalOnline += online.length;
    totalGrace += grace.length;

    console.log('  在房间里（' + online.length + ' 人在线' + (grace.length ? '，' + grace.length + ' 人掉线宽限中' : '') + '）:');
    for (const m of online) {
        const tags = [];
        if (m.key === d.hostId) tags.push('房主');
        if ((d.controllerIds || []).includes(m.key)) tags.push('有切歌权');
        console.log('    · ' + m.name + (tags.length ? '  [' + tags.join(' / ') + ']' : ''));
    }
    for (const m of grace) {
        // absent 里记着"什么时候断的"，宽限期 60 秒
        const a = (d.absent || {})[m.key];
        const left = a && a.since ? Math.max(0, (a.since + OFFLINE_TTL - Date.now()) / 1000) : null;
        console.log('    · ' + m.name + '  [掉线宽限中' + (left !== null ? '，还有 ' + Math.ceil(left) + ' 秒' : '') + ']');
    }
    if (!members.length) console.log('    （没人）');
    if (idx >= 0 && q.items.length) {
        const next = q.items[idx + 1];
        console.log('  下一首: ' + (next ? next.title : '（到底了）'));
    }
}

console.log('');
console.log('合计: ' + totalOnline + ' 人在线' + (totalGrace ? ' + ' + totalGrace + ' 人掉线宽限中' : '') + '，' + rooms.length + ' 个房间');
