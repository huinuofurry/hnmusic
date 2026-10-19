// 离线断言：默认收藏夹缓存的两条清理规则（2026/10/19）
//   ① 失效视频（标题「已失效视频」/ attr 位）→ 剔
//   ② 非音乐分区（分区表里 tid 不是音乐）→ 剔，**但**"看起来像首歌"的保留
//      （实测 B站 上真有音乐被传到 日常 / 同人·手书 / 配音 等分区，一律按分区剔会误删）
//
// 为什么单独一个脚本：这段逻辑在 `bili.js` 内部（读缓存时自愈），
// 用假的缓存 + 假的分区表就能测，**不需要联网、不需要起服务**。零依赖。
//
//   node scripts/check-fav-filter.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = mkdtempSync(path.join(os.tmpdir(), 'hnmusic-favfilter-'));
const CACHE = path.join(dir, 'fav-cache.json');
const TIDS = path.join(dir, 'fav-tids.json');
const TAGS = path.join(dir, 'fav-tags.json');
const DROP = path.join(dir, 'fav-drop.json');
process.env.HN_FAV_CACHE = CACHE;
process.env.HN_FAV_TIDS = TIDS;
process.env.HN_FAV_TAGS = TAGS;
process.env.HN_FAV_DROP = DROP;

let pass = 0;
let fail = 0;
const ok = (cond, label, extra) => {
    if (cond) {
        pass++;
        console.log('  OK   ' + label);
    } else {
        fail++;
        console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
    }
};

// 分区表：48 首正常音乐（tid=30），2 首非音乐（tid=228 人文历史），
// 1 首"非音乐分区但像歌"（tid=47 同人·手书 + 标题带【】）
const base = (bvid, title, extra = {}) => ({ bvid, title, author: '某UP', cover: '', duration: 100, view: 1000, ...extra });
const items = [];
for (let i = 0; i < 48; i++) items.push(base('BVm' + i, '【初音ミク】曲名 ' + i));
items.push(base('BVn1', '逻辑学入门：万能的上帝能不能造出自己举不起来的石头'));
items.push(base('BVn2', '远星物语 Boss 无伤'));
items.push(base('BVs1', '【本家投稿】霧雨が降る街で僕らは'));
items.push(base('BVn3', '某个没括号也不像歌的东西'));
items.push(base('BVd1', '已失效视频'));
const tids = { tids: {} };
for (let i = 0; i < 48; i++) tids.tids['BVm' + i] = { tid: 30, tname: '', title: '' };
tids.tids.BVn1 = { tid: 228, tname: '', title: '' };
tids.tids.BVn2 = { tid: 17, tname: '', title: '' };
tids.tids.BVs1 = { tid: 47, tname: '', title: '' };
tids.tids.BVn3 = { tid: 21, tname: '', title: '' };  // 日常：混着曲子，不能按分区剔
tids.tids.BVd1 = { tid: 30, tname: '', title: '' };
writeFileSync(TIDS, JSON.stringify(tids));
writeFileSync(DROP, JSON.stringify({ bvids: ['BVm0'] }));  // 用户点名删的（手工表）：即使它是音乐分区 + 像歌也要删
writeFileSync(CACHE, JSON.stringify({ at: Date.now(), folder: '默认收藏夹', total: items.length, mid: '1', items }));

const bili = await import('file:///' + path.resolve('src/bili.js').replace(/\\/g, '/'));
const j = await bili.favFolderCached('17800413', 100);
const kept = (j.items || []).map((x) => x.bvid);
const after = JSON.parse(readFileSync(CACHE, 'utf8')).items.map((x) => x.bvid);

console.log('读缓存 + 过滤：');
ok(kept.length === 49, '49 条留下（47 音乐 + 手书里的歌 + 日常分区那条；1 条被手工表删掉）', kept.length);
ok(!kept.includes('BVd1'), '「已失效视频」被剔掉');
ok(!kept.includes('BVn1') && !kept.includes('BVn2'), '两条非音乐（人文历史 / 单机游戏）被剔掉');
ok(kept.includes('BVs1'), '非音乐分区但像歌（同人·手书 + 【本家投稿】）**保留**', kept.includes('BVs1'));
ok(after.length === 49, '写回文件也变干净了（不是只过滤内存）', after.length);
ok(!kept.includes('BVm0'), '手工剔除表优先：音乐分区 + 像歌的一条照样删', kept.includes('BVm0'));

console.log('');
console.log('单条判定：');
ok(bili.looksLikeSong({ title: '【初音ミク】x' }) === true, '标题带【…】算像歌');
ok(bili.looksLikeSong({ title: 'Your Archive' }) === false, '纯英文标题不算像歌');
ok(bili.looksLikeSong({ title: 'Kikuo - 好孩子和狐仙 (イイコと妖狐)' }) === false, '“ - ” 不算像歌（要靠分区表兜）');

console.log('');
console.log('没有分区表时（例如表还没打全）：');
// ⚠️ 这里**必须给够 40 条**且 at 是"刚刚"：`favFolderCached` 在"缓存条数不够 / 过期"
//    时会去**真拉 B站**（第一版测试就这样偷偷联网了，还把线上收藏夹拉了一遍 ✗）。
const CACHE2 = path.join(dir, 'fav-cache2.json');
const TIDS2 = path.join(dir, 'fav-tids2.json');
writeFileSync(TIDS2, JSON.stringify({ tids: {} }));
const items2 = [];
for (let i = 0; i < 45; i++) items2.push(base('BVy' + i, '既没括号也不像歌的第 ' + i + ' 首'));
writeFileSync(CACHE2, JSON.stringify({ at: Date.now(), folder: '默认收藏夹', total: 45, mid: '1', items: items2 }));
process.env.HN_FAV_TIDS = TIDS2;
process.env.HN_FAV_CACHE = CACHE2;
const bili2 = await import('file:///' + path.resolve('src/bili.js').replace(/\\/g, '/') + '?v=2');
const j2 = await bili2.favFolderCached('17800413', 10);
ok((j2.items || []).length === 10 && j2.items[0].title === '既没括号也不像歌的第 0 首', '分区表是空的时候，**全部保留**（不知道就别删，也没去联网）', (j2.items || []).length);

console.log('');
console.log('标签规则（音游曲删、联名 VOCALOID 不删）：');
{
    const CACHE3 = path.join(dir, 'fav-cache3.json');
    const TIDS3 = path.join(dir, 'fav-tids3.json');
    const TAGS3 = path.join(dir, 'fav-tags3.json');
    // 都放在音乐分区（tid=30），这样"留下/剔掉"只可能由标签决定
    const list = [
        base('BVg1', '【初音ミク】某首被搬去 BMS 的曲子'),
        base('BVg2', '某首 Arcaea 收录曲（无术）'),
        base('BVg3', '某首纯音游曲'),
        base('BVg4', '世界计划 联名曲'),
        base('BVg5', '【重音テト】普通曲子'),
        base('BVg6', '神秘曲目'),
        base('BVg7', '【星界】某首 Arcaea 收录的术曲'),
        base('BVg8', 'チエルカ／エソテリカ - ツミキ × 宮下遊 [maimai でらっくす]（搬运）'),
        base('BVg9', '【pjsk】某曲 红谱AP'),
    ];
    // ⚠️ 缓存至少要 40 条才不会被 `favFolderCached` 判定为"要重新拉 B站"
    //    （第一版这里只有 6 条，测试真的联网了 ✗）
    const filler = [];
    for (let i = 0; i < 45; i++) filler.push(base('BVf' + i, '【初音ミク】填充 ' + i));
    const all3 = [...list, ...filler];
    const tids3 = { tids: {} };
    for (const it of all3) tids3.tids[it.bvid] = { tid: 30, tname: '', title: '' };
    writeFileSync(TIDS3, JSON.stringify(tids3));
    writeFileSync(TAGS3, JSON.stringify({
        tags: {
            BVg1: { tags: ['BMS', '初音ミク', '电子音乐'], title: '' },      // 有 VOCALOID 标签 ⇒ 留
            BVg2: { tags: ['Arcaea', '韻律源點'], title: '' },               // 纯音游 ⇒ 剔
            BVg3: { tags: ['muse dash', '喵斯快跑'], title: '' },            // 纯音游 ⇒ 剔
            BVg4: { tags: ['世界计划', 'PJSK', 'プロセカ'], title: '' },      // 联名 ⇒ 留
            BVg5: { tags: ['VOCALOID', 'UTAU'], title: '' },                 // 术 ⇒ 留
            BVg6: { tags: ['翻唱', '音乐'], title: '' },                     // 没音游标签 ⇒ 留
            BVg7: { tags: ['Arcaea', '韵律源点'], title: '' },               // 有音游标签，但标题里是术（星界）⇒ 留
            BVg8: { tags: ['maimaiでらっくす'], title: '' },                 // 标题里的「チエルカ」不能误判成「ルカ」⇒ 剔
            BVg9: { tags: ['音乐游戏', 'AP', 'Project SEKAI'], title: '' },   // 谱面实机：带世界计划也不留 ⇒ 剔
        },
    }));
    writeFileSync(CACHE3, JSON.stringify({ at: Date.now(), folder: '默认收藏夹', total: all3.length, mid: '1', items: all3 }));
    process.env.HN_FAV_TIDS = TIDS3;
    process.env.HN_FAV_TAGS = TAGS3;
    process.env.HN_FAV_CACHE = CACHE3;
    const bili3 = await import('file:///' + path.resolve('src/bili.js').replace(/\\/g, '/') + '?v=3');
    // ⚠️ limit 必须 ≤ 缓存条数：`favFolderCached` 在"条数不够 min(n,40)"时会**去真拉 B站**
    const j3 = await bili3.favFolderCached('17800413', 100);
    const kept3 = (j3.items || []).map((x) => x.bvid);
    ok(!kept3.includes('BVg2') && !kept3.includes('BVg3'), '纯音游标签（Arcaea / muse dash）被剔掉', kept3);
    ok(kept3.includes('BVg1'), '带 BMS 标签但**是术**（有 初音ミク 标签）⇒ 保留', kept3);
    ok(kept3.includes('BVg4'), '世界计划 / PJSK 标签 ⇒ **保留**（用户明确要求）', kept3);
    ok(kept3.includes('BVg5') && kept3.includes('BVg6'), '普通术曲 / 没音游标签的 ⇒ 保留', kept3);
    ok(kept3.includes('BVg7'), '带 Arcaea 标签但**是术**（标题【星界】）⇒ 保留', kept3);
    ok(!kept3.includes('BVg8'), 'maimai 标签 + 非术（「チエルカ」不算「ルカ」）⇒ 剔掉', kept3);
    ok(!kept3.includes('BVg9'), '谱面实机（音乐游戏/AP）即便带世界计划标签 ⇒ 也剔掉', kept3);
}

console.log('');
console.log('明显不是音乐的标题（实况/教程/攻略…）：');
{
    const CACHE4 = path.join(dir, 'fav-cache4.json');
    const TIDS4 = path.join(dir, 'fav-tids4.json');
    const TAGS4 = path.join(dir, 'fav-tags4.json');
    const DROP4 = path.join(dir, 'fav-drop4.json');
    const list4 = [
        base('BVx1', '中文实况【字幕】说谎公主与失明王子【完结】'),
        base('BVx2', '【初音ミク】攻略不可能！？不幸的女孩【pなっつ!】'),
        base('BVx3', '【歌愛ユキ】人生速通法！/立入禁止'),
        base('BVx4', '【重音テト】普通曲子'),
    ];
    const filler4 = [];
    for (let i = 0; i < 45; i++) filler4.push(base('BVz' + i, '【初音ミク】填充 ' + i));
    const all4 = [...list4, ...filler4];
    const tids4 = { tids: {} };
    for (const it of all4) tids4.tids[it.bvid] = { tid: 30, tname: '', title: '' };
    writeFileSync(TIDS4, JSON.stringify(tids4));
    writeFileSync(TAGS4, JSON.stringify({ tags: {} }));
    writeFileSync(DROP4, JSON.stringify({ bvids: [] }));
    writeFileSync(CACHE4, JSON.stringify({ at: Date.now(), folder: '默认收藏夹', total: all4.length, mid: '1', items: all4 }));
    process.env.HN_FAV_TIDS = TIDS4;
    process.env.HN_FAV_TAGS = TAGS4;
    process.env.HN_FAV_DROP = DROP4;
    process.env.HN_FAV_CACHE = CACHE4;
    const bili4 = await import('file:///' + path.resolve('src/bili.js').replace(/\\/g, '/') + '?v=4');
    const j4 = await bili4.favFolderCached('17800413', 100);
    const kept4 = (j4.items || []).map((x) => x.bvid);
    ok(!kept4.includes('BVx1'), '「中文实况」即使带【字幕】也剔掉（不能因为有括号就当歌）', kept4.includes('BVx1'));
    ok(kept4.includes('BVx2') && kept4.includes('BVx3'), '【初音ミク】攻略不可能 / 【歌愛ユキ】人生速通法 是术曲 ⇒ 保留', kept4);
    ok(kept4.includes('BVx4'), '普通术曲照常保留', kept4);
}

console.log('');
console.log('每天 6 点刷新（上海时间）的判据：');
{
    const at = (s) => Date.parse(s);
    ok(bili.favNeedsRefresh({ at: at('2026-10-19T05:00:00+08:00') }, at('2026-10-19T05:59:00+08:00')) === false, '6 点前：刚刷过的不用刷');
    ok(bili.favNeedsRefresh({ at: at('2026-10-19T05:00:00+08:00') }, at('2026-10-19T06:01:00+08:00')) === true, '过了 6 点就要刷一次');
    ok(bili.favNeedsRefresh({ at: at('2026-10-19T06:30:00+08:00') }, at('2026-10-20T05:00:00+08:00')) === false, '第二天凌晨 5 点：昨天 6 点后刷过 ⇒ 不刷');
    ok(bili.favNeedsRefresh({ at: at('2026-10-19T06:30:00+08:00') }, at('2026-10-20T06:05:00+08:00')) === true, '第二天 6 点后 ⇒ 刷');
    ok(bili.favNeedsRefresh(null) === true, '没有缓存 ⇒ 刷');
}

console.log('');
console.log('歌姬名单（2026/10/19 用户核对后补的一批）：');
{
    const must = ['カゼヒキ', 'カゼヒキβ', '鳴花ヒメ', '鳴花ミコト', '狐子', '雨衣', 'VY1', '宮舞モカ', '唄音ウタ', '星尘Infinity', '洛天依', '乐正绫', 'Ci flower', '冥鳴ひまり', '葛駄夜音', 'ネヂェム', '心華', 'りむる', '健音テイ', '暗鳴ニュイ', '湯鬱声からす', '雪歌ユフ', '紲星あかり', '永夜Minus', '双葉湊音', 'Fukase', 'MAYU', '琴葉茜', '琴葉葵', '春日部つむぎ', '70D', '音街ウナ', '白寝ねんね'];
    const miss = must.filter((n) => !bili.isVoiceName(n));
    ok(!miss.length, '新补的歌姬名都认得（' + must.length + ' 个）', miss);
    // 反面：P主 / 真人歌手不能被当成歌姬
    const notVoice = ['MARETU', 'ナユタン星人', 'バルーン', 'まふまふ', 'sasakure.UK', 'むﾄ', 'Mai'];
    const wrong = notVoice.filter((n) => bili.isVoiceName(n));
    ok(!wrong.length, 'P主 / 真人歌手不会被误判成歌姬', wrong);
    // 标题里带这些名字时要能认出来
    ok(bili.looksLikeVocaloidSong('【カゼヒキ】ブルーセ【South&】'), '【カゼヒキ】标题能被认出是术');
    ok(bili.looksLikeVocaloidSong('【70D】找到你了!【夏山よつぎ】'), '【70D】标题能被认出是术');
    ok(!bili.looksLikeVocaloidSong('【Arcaea】Testify (Story ver.)'), '音游曲不会被当成术（反例）');
}

console.log('');
console.log('歌姬解析（"曲名 / 歌姬"、feat.、多人写法）：');
{
    const cases = [
        ['君ならどうしたっけ / 鳴花ミコト', '鳴花ミコト'],
        ['Overkill / MIKU', '初音ミク'],
        ['你的失踪 / 结月缘', '結月ゆかり'],
        ['Fukase feat.可不', '可不'],
        ['【初音ミク・鳴花ヒメ】さよならディスコ', '初音ミク'],
        ['Pheles/Hatsune Miku＆MEIKO', '初音ミク'],
        ['ばんそうこう / IA', 'IA'],
        ['【70D】找到你了!【夏山よつぎ】', '70D'],
        ['【星尘Infinity】再現.leaper', '星尘'],
    ];
    const bad = cases.filter(([t0, want]) => bili.parseVoiceOf(t0) !== want);
    ok(!bad.length, '"曲名 / 歌姬"、feat.、多人写法都能解析出歌姬（' + cases.length + ' 例）', bad.map((x) => x[0]));
    const canon = [['flower', 'flower'], ['Ci flower', 'flower'], ['星尘Infinity', '星尘'], ['カゼヒキβ', 'カゼヒキ'], ['音街ウナSV', '音街ウナ'], ['MIKU', '初音ミク'], ['结月缘', '結月ゆかり'], ['镜音铃', '鏡音リン']];
    const bad2 = canon.filter(([a, b]) => bili.canonVoice(a) !== b);
    ok(!bad2.length, '同一个歌姬的不同写法归一到同一个名字', bad2.map((x) => x[0]));
}

rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(fail ? '结果: 有问题（' + fail + ' 项）' : '结果: 全部通过（' + pass + ' 项）');
process.exit(fail ? 1 : 0);
