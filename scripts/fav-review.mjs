// 默认收藏夹体检清单 v2（2026/10/19）：**按 UP 主聚合** + 批量勾选，方便一次删一整位 UP 的歌。
//
// 为什么改：v1 只按"可疑度"排序，用户反馈"筛出来的太少了，挑不动"。实际上他删的那批
// 高度集中在少数 UP 主（BOF / BMS 投稿者整号都是音游曲）⇒ 按 UP 聚合 + "你删过的 UP" 才是
// 最省力的挑法。
//
//   node scripts/fav-review.mjs
//   node scripts/fav-review.mjs --limit=300
//
// 输出：backups/fav-review.html（本地双击打开，不用起服务）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRV = process.env.HN_SRV || 'http://124.220.169.253:8443';
const MID = process.env.HN_FAV_MID || '17800413';
const OUT = path.join(ROOT, 'backups', 'fav-review.html');
const argv = process.argv.slice(2);
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

// 音游 / BMS / 谱面 味儿的标题
const GAME_TITLE = /BOF|BGA|音源|譜面|谱面|音ゲー|音游|arcaea|phigros|bms|chunithm|maimai|maimaiでらっくす|舞萌|オンゲキ|ongeki|iidx|sdvx|sound voltex|wacca|jubeat|popn|ポップン|ノスタルジア|deemo|cytus|osu!|muse ?dash|喵斯|プロセカ|世界计划|pjsk|太鼓|beatmania/i;
// 标题里就有歌姬名 ⇒ 大概率本来就是术曲（降权用）
const VOICE_TITLE = /ミク|初音|テト|重音|鏡音|镜音|巡音|ルカ|kaito|meiko|gumi|flower|可不|ずんだ|歌愛|ユキ|裏命|星界|知声|羽累|無來|花隈|千冬|足立|ついな|ナースロボ|ボカロ|vocaloid|ボカコレ/i;
const NON_MUSIC_TITLE = /实况|攻略|教程|录播|解说|开箱|vlog|游戏流程|通关|速通|抽卡|测评|评测|装机|编程|教学|直播回放|整活|试玩|实机演示|混剪/i;
const GAME_TAG = /音游|音乐游戏|游戏音乐|音ゲー|谱面|手元|bms|arcaea|韵律源点|phigros|chunithm|中二节奏|maimai|舞萌|太鼓|deemo|cytus|osu|muse ?dash|喵斯|bang ?dream|バンドリ|邦邦|d4dj|beatmania|iidx|sdvx|ongeki|オンゲキ|wacca|jubeat|popn|ポップン|ノスタルジア/i;

const loadJson = (p, fb) => {
    try {
        return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
        return fb;
    }
};

const tagsDb = loadJson(path.join(ROOT, 'backups', 'fav-tags.json'), { tags: {} }).tags || {};
const tidsDb = loadJson(path.join(ROOT, 'backups', 'fav-tids.json'), { tids: {} }).tids || {};
const dropDbRaw = loadJson(path.join(ROOT, 'backups', 'fav-drop.json'), { bvids: [] });
const dropBvids = Array.isArray(dropDbRaw) ? dropDbRaw : dropDbRaw.bvids || [];
const dropped = new Set(dropBvids);

const r = await fetch(SRV + '/api/bili/fav-folder?mid=' + MID + '&limit=5000');
if (!r.ok) throw new Error('取收藏夹失败 HTTP ' + r.status);
const j = await r.json();
let items = j.items || [];

// ① 每个 UP 主的统计
const upStats = new Map(); // author -> { total, dropped, gameTitle }
for (const it of items) {
    const a = String(it.author || '(未知)');
    if (!upStats.has(a)) upStats.set(a, { total: 0, dropped: 0, gameTitle: 0 });
    const s = upStats.get(a);
    s.total++;
    if (GAME_TITLE.test(String(it.title || ''))) s.gameTitle++;
}
// 已删的 124 条里涉及哪些 UP（删掉的已经不在缓存里了，只能从手工表 + 之前的统计文件里看；
// 这里退一步：用"缓存里还剩几首"+"标题音游味"来判断，另外把删掉的 UP 名单从 backups 里读）
const deletedUps = loadJson(path.join(ROOT, 'backups', 'fav-deleted-ups.json'), { ups: [] }).ups || [];
const deletedUpMap = new Map(deletedUps.map((u) => [String(u.author), u.deleted]));
// ⚠️ 只有"删除比例够高"的 UP 才值得高亮 —— 用户在 627 首的号里删了 1 首，
//    不能因此把他剩下 626 首都标成可疑（第一版就这么干了：页面一片红，等于没筛）。
const strongDelUps = new Set();
for (const [author, del] of deletedUpMap) {
    const st = upStats.get(author) || { total: 0 };
    const before = st.total + del; // 删掉的不在缓存里了 ⇒ 原来总数 = 剩的 + 删的
    if (del >= 3 || (del >= 2 && before > 0 && del / before >= 0.2)) strongDelUps.add(author);
}

function score(it) {
    const t = String(it.title || '');
    const a = String(it.author || '(未知)');
    const rec = tagsDb[it.bvid];
    const tagStr = ((rec && rec.tags) || []).join(' ');
    let s = 0;
    const why = [];
    if (GAME_TAG.test(tagStr)) { s += 5; why.push('标签有音游'); }
    if (GAME_TITLE.test(t)) { s += 3; why.push('标题有音游/BOF/BGA'); }
    if (strongDelUps.has(a)) { s += 6; why.push('你整号删过这个UP(' + deletedUpMap.get(a) + '首)'); }
    const st = upStats.get(a);
    if (st && st.gameTitle >= 2) { s += 2; why.push('这位UP有多首音游味'); }
    if (!rec) why.push('没抓过标签');
    if (NON_MUSIC_TITLE.test(t) && !VOICE_TITLE.test(t)) { s += 4; why.push('标题明显不是音乐'); }
    if (VOICE_TITLE.test(t)) { s -= 4; why.push('标题看着是术'); }
    return { s, why: why.join(' · ') };
}

const rows = items.map((it) => {
    const m = score(it);
    return { ...it, _s: m.s, _why: m.why };
}).sort((a, b) => b._s - a._s || String(a.author).localeCompare(String(b.author)));
if (LIMIT) rows.length = Math.min(rows.length, LIMIT);

// UP 榜：先按"你删过的"排，再按"音游味标题数"排
const upBoard = [...upStats.entries()]
    .map(([author, s]) => ({ author, total: s.total, gameTitle: s.gameTitle, deleted: deletedUpMap.get(author) || 0 }))
    .filter((u) => strongDelUps.has(u.author) || u.gameTitle > 0)
    .sort((a, b) => b.deleted - a.deleted || b.gameTitle - a.gameTitle || b.total - a.total)
    .slice(0, 60);

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rowsHtml = rows.map((it, i) => `<tr data-s="${it._s}" data-up="${esc(it.author)}">
<td class="n">${i + 1}</td>
<td><input type="checkbox" data-bv="${esc(it.bvid)}"></td>
<td class="bv">${esc(it.bvid)}</td>
<td class="t" title="${esc(it.title)}">${esc(it.title)}</td>
<td class="a"><button class="upbtn" data-up="${esc(it.author)}">${esc(it.author)}</button></td>
<td class="why">${esc(it._why)}</td></tr>`).join('\n');

const upHtml = upBoard.map((u) => `<button class="upcard" data-up="${esc(u.author)}">
  <b>${esc(u.author)}</b>
  <span>剩 ${u.total} 首${u.deleted ? ' · 已删 ' + u.deleted : ''}${u.gameTitle ? ' · 音游味 ' + u.gameTitle : ''}</span>
</button>`).join('\n');

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>收藏夹体检 v2（${rows.length} 条 / ${upStats.size} 位 UP）</title>
<style>
 body{font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;margin:0;background:#f6f7fb;color:#222}
 header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e3e6ef;padding:9px 14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;z-index:20}
 h1{font-size:15px;margin:0 10px 0 0}
 input[type=search]{padding:6px 10px;border:1px solid #ccd2e0;border-radius:8px;min-width:240px}
 button{padding:6px 11px;border:1px solid #ccd2e0;background:#fff;border-radius:8px;cursor:pointer;font-size:12px}
 button.primary{background:#3a5bd9;border-color:#3a5bd9;color:#fff}
 button.warn{background:#c0392b;border-color:#c0392b;color:#fff}
 .hint{color:#667;margin-left:auto;font-size:12px}
 #ups{display:flex;gap:8px;overflow-x:auto;padding:10px 14px;background:#fff;border-bottom:1px solid #e3e6ef}
 .upcard{display:flex;flex-direction:column;gap:2px;text-align:left;white-space:nowrap;border-radius:10px}
 .upcard b{font-size:12px} .upcard span{font-size:11px;color:#778}
 .upcard.on{background:#3a5bd9;border-color:#3a5bd9;color:#fff} .upcard.on span{color:#dfe6ff}
 table{border-collapse:collapse;width:100%;background:#fff}
 th,td{padding:5px 8px;border-bottom:1px solid #eef1f7;vertical-align:top;text-align:left}
 th{position:sticky;top:46px;background:#f2f4fa;font-size:12px;color:#445;z-index:10}
 td.n{color:#889;width:44px} td.bv{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#667;white-space:nowrap}
 td.t{max-width:560px} td.a{white-space:nowrap;max-width:170px;overflow:hidden;text-overflow:ellipsis}
 .upbtn{border:0;background:none;color:#3a5bd9;padding:0;font-size:12px;text-decoration:underline}
 td.why{font-size:11px;color:#b03;max-width:280px}
 tr.s6{background:#ffefef} tr.s3{background:#fff8ec}
 .box{padding:10px 14px;background:#fff;border-top:1px solid #e3e6ef;position:sticky;bottom:0}
 textarea{width:100%;height:96px;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin-top:6px}
</style>
<header>
  <h1>收藏夹体检 v2</h1>
  <input id="q" type="search" placeholder="搜标题 / UP 主 / bvid">
  <button id="selUp" class="primary">全选当前筛选</button>
  <button id="onlyDel">只看「整号删过的 UP」</button>
  <button id="onlyGame">只看音游味</button>
  <button id="reset">重置</button>
  <button id="copy" class="warn">复制勾选的 bvid</button>
  <span class="hint">${rows.length} 条 · ${upStats.size} 位 UP · 点 UP 名单可只看他</span>
</header>
<div id="ups">${upHtml}</div>
<table>
<thead><tr><th>#</th><th></th><th>bvid</th><th>标题</th><th>UP 主</th><th>为什么可疑</th></tr></thead>
<tbody id="tb">
${rowsHtml}
</tbody></table>
<div class="box">
  <b>勾选结果</b>（复制发我）：
  <textarea id="out" readonly></textarea>
</div>
<script>
const tb = document.getElementById('tb');
const out = document.getElementById('out');
const q = document.getElementById('q');
const ups = document.getElementById('ups');
let filterUp = '';
let onlyDel = false;
let onlyGame = false;
const DELETED_UPS = new Set(${JSON.stringify([...strongDelUps])});
function visible(tr) {
  const kw = q.value.trim().toLowerCase();
  if (kw && !tr.textContent.toLowerCase().includes(kw)) return false;
  if (filterUp && tr.dataset.up !== filterUp) return false;
  if (onlyDel && !DELETED_UPS.has(tr.dataset.up)) return false;
  if (onlyGame && Number(tr.dataset.s) < 3) return false;
  return true;
}
function refresh() {
  for (const tr of tb.rows) tr.style.display = visible(tr) ? '' : 'none';
  for (const b of ups.querySelectorAll('.upcard')) b.classList.toggle('on', b.dataset.up === filterUp);
  const picked = [...tb.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.dataset.bv);
  out.value = picked.join('\\n');
  document.getElementById('copy').textContent = '复制勾选的 bvid（' + picked.length + '）';
}
q.addEventListener('input', refresh);
ups.addEventListener('click', (e) => {
  const b = e.target.closest('.upcard');
  if (!b) return;
  filterUp = filterUp === b.dataset.up ? '' : b.dataset.up;
  refresh();
});
tb.addEventListener('click', (e) => {
  const b = e.target.closest('.upbtn');
  if (!b) return;
  filterUp = b.dataset.up;
  refresh();
});
document.getElementById('selUp').addEventListener('click', () => {
  for (const tr of tb.rows) {
    if (visible(tr)) { const c = tr.querySelector('input[type=checkbox]'); if (c) c.checked = true; }
  }
  refresh();
});
document.getElementById('onlyDel').addEventListener('click', (e) => {
  onlyDel = !onlyDel; e.target.classList.toggle('primary', onlyDel); refresh();
});
document.getElementById('onlyGame').addEventListener('click', (e) => {
  onlyGame = !onlyGame; e.target.classList.toggle('primary', onlyGame); refresh();
});
document.getElementById('reset').addEventListener('click', () => {
  q.value = ''; filterUp = ''; onlyDel = false; onlyGame = false;
  document.getElementById('onlyDel').classList.remove('primary');
  document.getElementById('onlyGame').classList.remove('primary');
  tb.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false; });
  refresh();
});
document.getElementById('copy').addEventListener('click', async () => {
  refresh();
  try { await navigator.clipboard.writeText(out.value); } catch { out.select(); document.execCommand('copy'); }
});
tb.addEventListener('change', refresh);
refresh();
</script>`;

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, html);

const hi = rows.filter((x) => x._s >= 3).length;
console.log('缓存 ' + items.length + ' 条 / ' + upStats.size + ' 位 UP，其中可疑(≥3) ' + hi + ' 条');
console.log('已生成: ' + path.relative(ROOT, OUT));
console.log('');
console.log('UP 榜前 20（剩 / 已删 / 音游味标题数）:');
for (const u of upBoard.slice(0, 20)) console.log('  ' + String(u.author).padEnd(20) + ' 剩 ' + String(u.total).padStart(3) + ' 已删 ' + String(u.deleted).padStart(2) + ' 音游味 ' + u.gameTitle);
