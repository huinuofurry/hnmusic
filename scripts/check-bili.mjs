// 离线检查 B 站相关的纯逻辑（不联网、不碰数据）。
//
// 为什么单独有这个文件：parseUid 这种"从用户输入里认出意图"的纯字符串解析
// 最容易漏写法。2026/10/15 用户实际抓到一个 —— B 站搜索框认 `uid<数字>`，
// 而我们只认纯数字，于是他输了 uid17800413 搜不到人。
// 这种事不该靠"想起来才测"，所以在提交前固定跑一遍。
//
// 用法：node scripts/check-bili.mjs
import {
    parseUid,
    isProxyAllowed,
    trustHost,
    pickDaily,
    dailyPageNumbers,
    firstCidOf,
    looksDead,
    friendlyBiliError,
    rankCandidates,
    personalizedOn,
    recentSet,
    buildCookie,
} from '../src/bili.js';

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
    if (cond) {
        pass++;
        console.log('OK   ' + label);
    } else {
        fail++;
        console.log('FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
    }
}

const MID = '17800413';

console.log('--- 认得出 UID 的写法 ---');
const asUid = [
    MID, // 纯数字
    'uid' + MID, // B 站搜索框的写法（用户最自然会这么打）
    'UID' + MID, // 大小写都要认
    'Uid' + MID,
    'uid:' + MID,
    'uid：' + MID, // 中文冒号，写中文的人很容易打
    'uid ' + MID,
    'uid  ' + MID, // 多个空格
    ' ' + MID + ' ', // 前后空格
    '\t' + MID,
    'https://space.bilibili.com/' + MID,
    'http://space.bilibili.com/' + MID,
    'space.bilibili.com/' + MID,
    'space.bilibili.com/' + MID + '/',
    'https://space.bilibili.com/' + MID + '/favlist?spm_id_from=333.1007',
    'https://www.bilibili.com/space/' + MID,
];
for (const s of asUid) ok(parseUid(s) === MID, JSON.stringify(s) + ' → ' + MID, parseUid(s));

console.log('');
console.log('--- 不能误判成 UID 的写法（要交给按名字搜）---');
const notUid = [
    '灰诺-',
    '初音未来_Crypton',
    'uid',
    'uidabc',
    'uid:abc',
    'bilibili', // 光有域名没有数字
    'space.bilibili.com', 
    'https://www.bilibili.com/video/BV1Aupg64ECJ', // 视频链接不是空间链接
    '12345678901234567890123', // 21 位，超过 mid 的可能性
    '',
    '   ',
];
for (const s of notUid) ok(parseUid(s) === null, JSON.stringify(s) + ' → null（按名字搜）', parseUid(s));

console.log('');
console.log('--- 边界：'.padEnd(40, '-'));
ok(parseUid(undefined) === null, 'undefined → null');
ok(parseUid(null) === null, 'null → null');
// 传数字类型不崩就行。实际调用方（url.searchParams.get）永远是字符串，
// 所以这里宽松处理：数字也当 UID 认（本来就是个 mid）。
ok(parseUid(123456) === '123456', '数字类型不崩（宽松当 UID 认）', parseUid(123456));

console.log('');
console.log('--- /proxy 白名单：既要拦住内网，又不能把 B 站的新 CDN 拦掉 ---');
// ⚠️ 2026/10/15 真事故：B 站会**按歌**把音频放在不同 CDN 上，
//    那天起开始用 *.edge.mountaintoys.cn，白名单没跟上 ——
//    结果是**只有一部分歌**放不出来（浏览器报 "no supported source"），
//    看着像"点了没反应、而且有概率"。
ok(isProxyAllowed('upos-sz-estgcos.bilivideo.com') === true, 'bilivideo.com 的 CDN 放行');
ok(isProxyAllowed('i0.hdslb.com') === true, 'hdslb.com（封面）放行');
ok(isProxyAllowed('rq3a904j.edge.mountaintoys.cn') === true, 'B 站白牌 CDN mountaintoys.cn 放行（就是它挂过）');
ok(isProxyAllowed('upos-hz-mirrorakam.akamaized.net') === true, 'akamaized.net 放行');
// 这些是 SSRF 防线，必须继续拦
ok(isProxyAllowed('evilbilivideo.com') === false, 'evilbilivideo.com 必须拦住（后缀要带点）');
ok(isProxyAllowed('127.0.0.1') === false, '127.0.0.1 必须拦住');
ok(isProxyAllowed('localhost') === false, 'localhost 必须拦住');
ok(isProxyAllowed('169.254.169.254') === false, '云元数据地址 169.254.169.254 必须拦住');
ok(isProxyAllowed('api.bilibili.com') === false, 'B 站 API 域名不该被代理（只代理媒体）');
// 动态登记：B 站 API 亲手给的地址，域名自动可信（以后再换 CDN 不会集体哑）
const NEW_CDN = 'https://brand-new-cdn-2026.example-cdn.cn/audio.m4s';
ok(isProxyAllowed('brand-new-cdn-2026.example-cdn.cn') === false, '没登记过的域名先不放行');
trustHost(NEW_CDN);
ok(isProxyAllowed('brand-new-cdn-2026.example-cdn.cn') === true, 'trustHost 之后放行（B 站给过的域名）');
trustHost('这不是 URL');
ok(isProxyAllowed('这不是 URL') === false, 'trustHost 收到垃圾输入不崩、也不登记');

// ---------- 每日随机推荐（纯函数，不联网）----------
// 用户 2026/10/16：「推荐页改成随机挑选我的默认收藏夹 20 首推荐，每天更新一次」。
// 两条关键性质：同一天必须**完全一致**（否则每刷新一次就变，还会反复打 B 站），
// 换一天必须**不一样**（否则就不叫"每天更新"）。
{
    const pool = Array.from({ length: 400 }, (_, i) => ({ bvid: 'BV' + i }));
    const a1 = pickDaily(pool, 20, '2026-10-16').map((x) => x.bvid);
    const a2 = pickDaily(pool, 20, '2026-10-16').map((x) => x.bvid);
    const b1 = pickDaily(pool, 20, '2026-10-17').map((x) => x.bvid);
    ok(a1.length === 20, '每日推荐：取满 20 首', a1.length);
    ok(a1.join() === a2.join(), '每日推荐：同一天两次完全一致（所有人看到同一批）');
    ok(a1.join() !== b1.join(), '每日推荐：换一天就不是同一批（这才叫"每天更新一次"）');
    ok(new Set(a1).size === 20, '每日推荐：20 首互不重复');
    ok(pickDaily(pool, 20, '2026-10-16')[0].bvid === a1[0], '每日推荐：纯函数，服务重启也不会变');
    ok(pickDaily(pool.slice(0, 5), 20, '2026-10-16').length === 5, '每日推荐：池子不够就有多少给多少');
    ok(pickDaily([], 20, '2026-10-16').length === 0, '每日推荐：空池子给空数组，不报错');

    const p1 = dailyPageNumbers(120, 4, '2026-10-16');
    const p2 = dailyPageNumbers(120, 4, '2026-10-16');
    const p3 = dailyPageNumbers(120, 4, '2026-10-17');
    ok(p1.length === 4 && new Set(p1).size === 4, '每日页码：挑 4 个互不重复的页', p1);
    ok(p1.join() === p2.join(), '每日页码：同一天一致');
    ok(p1.join() !== p3.join(), '每日页码：换一天换一批');
    ok(
        p1.every((n) => n >= 1 && n <= 120),
        '每日页码：都落在 1..120（不会越界让 B 站报错）',
        p1
    );
    ok(dailyPageNumbers(1, 4, '2026-10-16').join() === '1', '每日页码：只有 1 页时只给 1');
    ok(dailyPageNumbers(3, 4, '2026-10-16').length === 3, '每日页码：总页数少于要挑的数就全给');
}

console.log('');
// ---------- 分P：只播第 1 个分P（纯函数，不用联网）----------
// 用户 2026/10/16：「如果视频存在分p的话只播放第一个分p的音频就行」。
// 关键是**不能赌 B站 的 d.cid** —— 它是"默认分P"，不是"第 1P"的契约。
{
    const twoParts = {
        cid: 222, // ← 故意让 d.cid 指向第 2P：这正是要防的情况
        pages: [
            { page: 2, cid: 222, part: '第二集' },
            { page: 1, cid: 111, part: '第一集' },
        ],
    };
    ok(firstCidOf(twoParts) === '111', '分P：d.cid 指第 2P 时，仍然取第 1P 的 cid', firstCidOf(twoParts));
    ok(
        firstCidOf({ cid: 1, pages: [{ page: 1, cid: 111 }, { page: 2, cid: 222 }] }) === '111',
        '分P：正序 pages 取第 1P'
    );
    ok(firstCidOf({ cid: 999 }) === '999', '分P：没有 pages 时退回 d.cid（老逻辑兜底）');
    ok(firstCidOf({ pages: [] }) === '', '分P：既没 pages 也没 cid → 空串（调用方会报错）');
    ok(firstCidOf({ pages: [{ cid: 111 }] }) === '111', '分P：pages 里没写 page 字段时取第一条');
    ok(firstCidOf(null) === '', '分P：null 也不崩');
    ok(firstCidOf({ cid: 42773188374, pages: [{ page: 1, cid: 42773188374 }] }) === '42773188374', '分P：单P视频不受影响');
}

// ---------- 失效视频的判据（纯函数，不用联网）----------
// 用户 2026/10/16：「应该筛选掉已经失效的视频」。
// 下面这些样本都是从真实响应里抄下来的（收藏夹整页 39 条 attr:0 + 1 条 attr:9 那条）。
{
    const dead = { bvid: 'BV1uLN36hEqf', title: '已失效视频', attr: 9 };
    ok(looksDead(dead) === true, '失效判据：标题「已失效视频」+ attr 9 → 判失效', dead);
    ok(looksDead({ bvid: 'BV1x', title: '正常的歌', attr: 0 }) === false, '失效判据：attr 0 + 正常标题 → 不判失效');
    ok(looksDead({ bvid: 'BV1x', title: '正常的歌' }) === false, '失效判据：没有 attr/state 字段的正常条目 → 放过');
    ok(looksDead({ bvid: 'BV1x', title: '正常的歌', state: 0 }) === false, '失效判据：state 0 → 放过');
    ok(looksDead({ bvid: 'BV1x', title: '正常的歌', state: 1 }) === true, '失效判据：state 非 0 → 判失效（正常稿件全是 0）');
    ok(looksDead({ bvid: 'BV1x', title: '正常', attr: 1 }) === true, '失效判据：attr 位 1 → 判失效');
    ok(looksDead({ bvid: 'BV1x', title: '正常', attr: 8 }) === false, '失效判据：attr 8（不含失效位）→ 放过（别误杀）');
    ok(looksDead({ bvid: 'BV1x', title: '视频已失效' }) === true, '失效判据：标题里写"视频已失效"');
    ok(looksDead({ bvid: 'BV1x', title: '   ' }) === true, '失效判据：空标题 → 判失效（点了也播不了）');
    ok(looksDead({ title: '没有 bvid' }) === true, '失效判据：没有 bvid → 判失效');
    ok(looksDead(null) === true, '失效判据：null 也不崩');
    // ⚠️ 反面：attribute_v3 正常视频也是非 0（4/28/5），绝不能被当成失效信号
    ok(looksDead({ bvid: 'BV1x', title: '正常', attribute_v3: 28 }) === false, '失效判据：attribute_v3 非 0 不算失效（会误杀）');
    // 真实那条失效稿件的友好报错
    ok(
        friendlyBiliError({ biliCode: 62002, message: '稿件不可见' }) === '这个视频已经失效了（B站：稿件不可见）',
        '失效判据：62002 翻成人话'
    );
    ok(friendlyBiliError({ biliCode: 0, message: 'OK' }) === null, '失效判据：别的错误码不走这个映射');
}

// ---------- 相关推荐的挑拣逻辑（纯函数，不联网）----------
// 用户 2026/10/17："b站游客账号传回来的相关推荐的视频太多雷同了"
// ＋ "b站会根据我的偏好推送我没听过的冷门曲"（⇒ 配了小号 cookie 才走个性化流）
// 这里测"候选池 → 最终 10 首"那一步：别推它自己 / 别推失效 / **别再推最近刚看过的**
// / 每个 UP 主最多 2 首 / 不够时把看过的按最旧的补上（轮换，别空着）
{
    const mk = (bvid, author) => ({ bvid, author, title: bvid, cover: '', duration: 100 });
    const pool = [
        mk('BV1AAAAAAA1', 'UP-A'),
        mk('BV1AAAAAAA1', 'UP-A'), // 重复
        mk('BV1AAAAAAA2', 'UP-A'),
        mk('BV1AAAAAAA3', 'UP-A'), // 同一个 UP 第 3 首（应被限掉）
        mk('BV1BBBBBBB1', 'UP-B'),
        mk('BV1BBBBBBB2', 'UP-B'),
        mk('BV1CCCCCCC1', 'UP-C'),
        mk('BV1SELF0000', 'UP-D'), // 它自己
        { bvid: 'BV1DEAD0001', author: 'UP-E', title: '已失效视频' }, // 失效
    ];
    const r = rankCandidates(pool, { exclude: 'BV1SELF0000', limit: 10, maxPerAuthor: 2 });
    ok(!r.some((x) => x.bvid === 'BV1SELF0000'), '相关推荐挑拣：不推它自己');
    ok(!r.some((x) => x.bvid === 'BV1DEAD0001'), '相关推荐挑拣：不推失效的');
    ok(new Set(r.map((x) => x.bvid)).size === r.length, '相关推荐挑拣：结果里没有重复');
    ok(r.length === 6, '相关推荐挑拣：候选不够时**补满**（6 个候选全用上，不空着）', r.length);
    // ⚠️ 上面那条 limit=10 但只有 6 个候选 ⇒ 补位阶段会突破"每作者 2 首"，
    //    这是**有意的**（宁可多给同一个 UP 主一首，也别让列表短一截）。
    //    所以"每作者最多 2 首"要在**候选充足**时测 ✓（同一对参数换个 limit）
    const rCap = rankCandidates(pool, { exclude: 'BV1SELF0000', limit: 5, maxPerAuthor: 2 });
    ok(rCap.filter((x) => x.author === 'UP-A').length === 2, '相关推荐挑拣：候选充足时同一个 UP 主最多 2 首', rCap.map((x) => x.author));

    const recent = new Set(['BV1AAAAAAA1', 'BV1BBBBBBB1', 'BV1CCCCCCC1']);
    const r2 = rankCandidates(pool, { exclude: 'BV1SELF0000', limit: 10, maxPerAuthor: 2, recent });
    ok(!r2.slice(0, 3).some((x) => recent.has(x.bvid)), '相关推荐挑拣：优先给**没看过**的', r2.slice(0, 3).map((x) => x.bvid));
    ok(r2.length === 6, '相关推荐挑拣：看过的补在后面，不空着', r2.length);
    ok(rankCandidates(pool, { exclude: '', limit: 3, maxPerAuthor: 2 }).length === 3, '相关推荐挑拣：limit 生效');

    ok(personalizedOn() === false, '没设 HN_BILI_COOKIE 时个性化推荐关闭（走匿名，降级安全）');
    ok(recentSet() instanceof Set, '最近看过的记忆是个 Set');
}

// ---------- Cookie 合并（2026/10/17 大 bug 的回归测试）----------
// 曾经写成 `for (const part of anon + '; ' + user)` —— 对字符串做 for...of
// 是**逐字符**遍历 ⇒ 合并结果永远是空串 ⇒ 所有需要登录的 B站 接口都 -101 ✗
// 这个纯函数必须钉死：合并后 SESSDATA/bili_jct 都在、匿名键也在、用户值优先。
{
    const anon = 'buvid3=ANON3; buvid4=ANON4; b_nut=123';
    const user = 'SESSDATA=abc%2Cdef; bili_jct=jct123; DedeUserID=999';
    const c = buildCookie(anon, user);
    ok(c.includes('SESSDATA=abc%2Cdef'), 'Cookie 合并：SESSDATA 没丢', c.slice(0, 60));
    ok(c.includes('bili_jct=jct123'), 'Cookie 合并：bili_jct 没丢');
    ok(c.includes('buvid3=ANON3'), 'Cookie 合并：匿名指纹的键也保留');
    ok(c.split(';').length === 6, 'Cookie 合并：6 个键（3 匿名 + 3 用户）', c.split(';').length);
    // 用户的值优先（同名键以 user 的为准）
    ok(buildCookie('buvid3=OLD', 'buvid3=NEW').includes('buvid3=NEW'), 'Cookie 合并：同名键用户优先');
    ok(!buildCookie('buvid3=OLD', 'buvid3=NEW').includes('OLD'), 'Cookie 合并：旧值被覆盖');
    // 空值/畸形输入不能崩，也只能返回空串
    ok(buildCookie('', '') === '', 'Cookie 合并：两边都空 ⇒ 空串');
    ok(buildCookie('', user).includes('SESSDATA='), 'Cookie 合并：没有匿名指纹也能用');
    ok(buildCookie('garbage;;=x; a=1', '') === 'a=1', 'Cookie 合并：脏数据跳过，不崩', buildCookie('garbage;;=x; a=1', ''));
}

console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
    console.log('');
    console.log('⚠️  有失败项。注意两件事：');
    console.log('    ① 改 parseUid 时必须同时确认前端 placeholder 的示例写法也能用；');
    console.log('    ② 改 /proxy 白名单时别把 SSRF 防线（内网/元数据地址）放进来。');
}
process.exit(fail ? 1 : 0);
