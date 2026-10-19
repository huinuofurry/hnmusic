#!/usr/bin/env node
// 前端自检：public/index.html 的内联脚本。
//
//   node scripts/check-frontend.mjs            ← 检查项目里的 public/index.html
//   node scripts/check-frontend.mjs <路径>      ← 检查别的文件（用来验证这个脚本本身有效）
//
// 为什么要有这个脚本：2026/10/15 我把弹窗 HTML 写到了 <script> 之后，
// 脚本顶层 $('modal-close') 拿到 null，addEventListener 抛错，**整个脚本断掉、
// 全站功能失效**。当时只做语法检查（new Function）完全没抓到 —— 语法是对的。
// 所以这里必须真的在一个"只有 script 之前那些元素"的假 DOM 上跑一遍。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, '..', 'public', 'index.html');

const html = fs.readFileSync(target, 'utf8');
// ⚠️⚠️ 页面可能不止一个内联 <script>（2026/10/19：头部多了 10 行的"主题引导"脚本，
// 在 <body> 之前就跑，用来避免深色主题闪白）。**必须取最长的那块 = 主脚本**。
// 这里原来取的是第一个 `/ <script> ... <\/script> /` ⇒ 实际检查的是那 10 行引导脚本，
// 于是 setPlayIcon / buildRow 之类全都"找不到"，整条前端护栏等于不存在（假红 + 假绿）。
const scriptBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const mainBlock = scriptBlocks.reduce((a, b) => (a && a[1].length >= b[1].length ? a : b), null);
const js = mainBlock ? mainBlock[1] : '';
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
if (!js) {
    console.log('FAIL 找不到内联 <script>');
    process.exit(1);
}
let bad = 0;
const fail = (msg) => {
    console.log('FAIL ' + msg);
    bad++;
};
console.log('检查文件: ' + target);
if (scriptBlocks.length > 1) {
    console.log('信息 页面有 ' + scriptBlocks.length + ' 个内联 <script>，主脚本取最长那块（' + js.length + ' 字符）');
}

// ---------- 1. 语法 ----------
try {
    new Function(js);
    console.log('OK   inline script 语法通过 (' + js.split('\n').length + ' 行)');
} catch (e) {
    fail('语法错误: ' + e.message);
}

// ---------- 2. 所有 $('id') 引用的元素必须定义在 script 之前 ----------
const scriptAt = mainBlock.index;
const head = html.slice(0, scriptAt);
// 由 JS 动态创建、所以不在 HTML 里的 id（加新的动态元素要登记到这里）
// btn-open-rooms：房间抽屉那个按钮是 JS 现造的（原来写在 HTML 里，重写后改成动态）
const DYNAMIC = ['btn-open-rooms'];
const beforeIds = [...head.matchAll(/id="([^"]+)"/g)].map((x) => x[1]);
const usedIds = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((x) => x[1]))];
const missing = usedIds.filter((u) => !beforeIds.includes(u) && !DYNAMIC.includes(u));
if (missing.length) {
    fail('这些 id 在 script 之前不存在（顶层 $() 会拿到 null）: ' + missing.join(', '));
} else {
    console.log('OK   ' + usedIds.length + ' 个静态 id 全部定义在 script 之前');
}

// ---------- 3. 真的在假 DOM 上执行一遍脚本 ----------
function stub(tag) {
    return {
        tagName: tag,
        hidden: false,
        value: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        controls: true,
        volume: 1,
        muted: false,
        currentTime: 0,
        duration: 0,
        paused: true,
        readyState: 0,
        src: '',
        maxLength: 0,
        placeholder: '',
        className: '',
        title: '',
        type: '',
        children: [],
        dataset: {},
        // first/lastElementChild：新代码里用 setIconButton 之后靠它拿文字节点
        //（`who.lastElementChild.className = 'account-name'`），假 DOM 不给就会崩
        get firstElementChild() {
            return this.children && this.children.length ? this.children[0] : null;
        },
        get lastElementChild() {
            return this.children && this.children.length ? this.children[this.children.length - 1] : null;
        },
        // style 要能 setProperty/getPropertyValue：歌单页头用
        // style.setProperty('--pl-cover', ...) 把封面喂给 CSS（模糊底色）
        style: {
            _vars: {},
            setProperty(k, v) {
                this._vars[k] = v;
            },
            getPropertyValue(k) {
                return this._vars[k] ?? '';
            },
            removeProperty(k) {
                delete this._vars[k];
            },
        },
        // classList 要**真的记住类**：以前 contains 恒为 false，
        // 于是"按 .cur 找正在播的那首"这种逻辑在测试里永远找不到东西
        //（我加第 33 节时就被这个绊了一下）。
        // ⚠️ 注意：直接写 `el.className = 'x'` 不会进这个集合 —— 代码里要按类查
        //    就得用 classList.add
        classList: {
            _ensure() {
                if (!this._set) this._set = new Set();
                return this._set;
            },
            add(c) {
                this._ensure().add(String(c));
            },
            remove(c) {
                this._ensure().delete(String(c));
            },
            toggle(c, on) {
                const s = this._ensure();
                const want = on === undefined ? !s.has(String(c)) : !!on;
                if (want) s.add(String(c));
                else s.delete(String(c));
                return want;
            },
            contains(c) {
                return this._ensure().has(String(c));
            },
        },
        addEventListener(type, fn) {
            this._handlers = this._handlers || {};
            (this._handlers[type] = this._handlers[type] || []).push(fn);
        },
        // 测试用：手动触发某个事件（比如 _fire('click') 看按钮点了会怎样）
        _fire(type, ev) {
            for (const fn of (this._handlers && this._handlers[type]) || []) fn(ev || {});
        },
        removeEventListener() {},
        // 记录"谁被滚进了视野"（第 33 节要验"打开队列面板会定位到正在播的那首"）。
        // 假 DOM 没有布局，所以只能记调用，验不了实际位置 —— 但"该滚的时候滚了、
        // 不该滚的时候没滚"是能验的。
        scrollIntoView(opt) {
            (globalThis.__scrolls = globalThis.__scrolls || []).push((opt && opt.block) || 'default');
        },
        appendChild(c) {
            this.children.push(c);
            return c;
        },
        append(...c) {
            this.children.push(...c);
        },
        // 2026/10/19 重写后大量用 replaceChildren()/insertBefore 换内容
        //（比 innerHTML 拼字符串安全）。假 DOM 必须支持，否则脚本第一次清列表就抛错。
        replaceChildren(...c) {
            this.children.length = 0;
            this.children.push(...c);
        },
        insertBefore(c) {
            this.children.push(c);
            return c;
        },
        hasAttribute(k) {
            return !!(this.attrs && k in this.attrs);
        },
        removeChild() {},
        remove() {},
        removeAttribute() {},
        // setAttribute 要真的存起来：播放模式的图标是内联 SVG
        //（createElementNS + setAttribute('d'/'viewBox')），
        // 假 DOM 里不存的话就断言不了图标画的是什么
        setAttribute(k, v) {
            this.attrs = this.attrs || {};
            this.attrs[k] = String(v);
        },
        getAttribute(k) {
            return (this.attrs && this.attrs[k]) ?? null;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
        focus() {},
        blur() {},
        select() {},
        load() {},
        play: () => Promise.resolve(),
        pause() {},
        getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        // 元素包含判断（"点面板外面就关掉"这类逻辑会用到）
        contains() {
            return false;
        },
        // Web Animations：2026/10/19 重写用 element.animate() 做过场
        //（假 DOM 不给就会抛 `animate is not a function`，把整页渲染当成失败）
        animate() {
            return { onfinish: null, oncancel: null, finished: Promise.resolve(), cancel() {}, finish() {}, play() {}, pause() {} };
        },
    };
}
// 统一的假 fetch。
// ⚠️ 为什么需要它：脚本一执行，**启动链就会真的跑起来**
//（loadMe → refreshState → refreshRoomList → joinFromUrl → showDefaultHome）。
// 如果假 fetch 对 /api/state 回一个 `{}`，`state` 就被冲成 undefined，
// 接着在别的断言里炸出"state.playlists is undefined"这种**误导性**报错 ——
// 我写第 22 节时就踩了这个坑。所以每个启动链会碰的地址都要回**结构正确**的对象。
function makeApiStub(overrides = {}) {
    const base = {
        '/api/auth/guest': { token: 'gtok' },
        '/api/auth/me': { session: { sid: 's1' }, user: null },
        '/api/state': { playlists: [], shared: [], queue: { items: [], currentId: null, mode: 'sequence' } },
        '/api/rooms': { rooms: [] },
        '/api/bili/fav-preview': { user: { name: '灰诺-' }, folder: { title: '默认收藏夹', count: 0 }, items: [] },
    };
    return async (url, opt) => {
        const u = String(url);
        for (const [k, v] of Object.entries(overrides)) {
            if (u.includes(k)) {
                const val = typeof v === 'function' ? v(opt, u) : v;
                return { ok: true, status: 200, json: async () => val };
            }
        }
        for (const [k, v] of Object.entries(base)) {
            if (u.includes(k)) return { ok: true, status: 200, json: async () => v };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };
}

// innerHTML = '' 必须真的把 children 清空，否则用假 DOM 测"渲染结果"会数错
function withInnerHTML(el) {    let html = '';
    Object.defineProperty(el, 'innerHTML', {
        get: () => html,
        set(v) {
            html = v;
            if (v === '') el.children.length = 0;
        },
    });
    return el;
}
// 造一份全新的假 DOM（每个用例一份，互不干扰）
function makeFakeDocument() {
    const nodes = new Map(beforeIds.map((id) => [id, withInnerHTML(stub('div'))]));
    return {
        getElementById: (id) => nodes.get(id) ?? null,
        createElement: (tag) => withInnerHTML(stub(tag)),
        // SVG 元素走这条（播放模式的图标是内联 SVG）
        createElementNS: (ns, tag) => withInnerHTML(stub(tag)),
        // copyText 在 HTTP 下的兜底路径要用它
        execCommand: () => true,
        addEventListener() {},
        // 2026/10/19 重写后用了 `document.querySelector('meta[name="theme-color"]')`
        // 去改浏览器地址栏颜色 —— 假 DOM 里 querySelector 一律返回 null 会当场崩，
        // 所以给它一个按选择器缓存的假元素（同一选择器每次拿到同一个对象）。
        querySelector: (() => {
            const qsCache = new Map();
            return (sel) => {
                if (!qsCache.has(sel)) qsCache.set(sel, withInnerHTML(stub('div')));
                return qsCache.get(sel);
            };
        })(),
        querySelectorAll: () => [],
        body: stub('body'),
        documentElement: stub('html'),
        _nodes: nodes,
    };
}
const fakeDocument = makeFakeDocument();
const fakeStorage = {
    _m: {},
    getItem(k) {
        return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null;
    },
    setItem(k, v) {
        this._m[k] = String(v);
    },
    removeItem(k) {
        delete this._m[k];
    },
};
// 假 window：脚本里可能用 addEventListener / innerWidth / matchMedia 之类
// ⚠️ matchMedia 在真浏览器里是**全局函数**（2026/10/19 的重写用它判断"系统深色"和
// "减少动效"）。假环境不补它，脚本第一次执行就 `matchMedia is not defined`，
// 于是后面所有"在假 DOM 上跑一遍"的检查全部假红 —— 那不是前端的问题。
const fakeMatchMedia = (query) => ({
    matches: false,
    media: String(query || ''),
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
});
globalThis.matchMedia = fakeMatchMedia;
// requestAnimationFrame：2026/10/19 重写用它做"内容切换"的过渡（transitionContent）。
// 假环境里必须**同步**执行回调，否则内容永远不渲染 —— 于是"首页应该有 20 行"
// 这种断言会全红，而原因跟功能一点关系都没有。
globalThis.requestAnimationFrame = (fn) => {
    try { fn(0); } catch { /* 测试里忽略回调抛错，真浏览器里由页面自己的 try/catch 兜 */ }
    return 0;
};
globalThis.cancelAnimationFrame = () => {};
const fakeWindow = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: fakeMatchMedia,
    innerWidth: 1280,
    innerHeight: 800,
};
try {
    new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', js)(
        fakeDocument,
        fakeStorage,
        () => new Promise(() => {}), // fetch 永不 resolve：只验顶层同步执行
        { clipboard: undefined },
        fakeWindow,
        () => 0 // 加载阶段不该依赖定时器
    );
    console.log('OK   在假 DOM 上执行到结尾没抛错（script 之前解析出的元素 ' + beforeIds.length + ' 个）');
} catch (e) {
    fail('顶层执行抛错（真浏览器里这会整站崩掉）: ' + e.message);
}

// ---------- 4. 关键实现还在不在 ----------
const need = [
    'loadMe', 'renderAuth', 'openLoginModal', 'openRegisterModal', 'doLogout', 'dnOf',
    'openAccount', 'closeAccount', 'accountMsg', 'acct-save-nick', 'acct-save-pw', 'acct-logout',
    '/api/auth/profile', '/api/auth/password',
    'renderAdmin', 'doRevokeInvite', 'setToken', 'TOKEN_KEY',
    'Authorization', '/api/auth/me', '/api/auth/login', '/api/auth/register', '/api/auth/logout',
    '/api/admin/invites',
    'openRoomStream', 'handleSse', 'onRoomEvent', 'applyRoomState', 'applyPlayback', 'applyAudio',
    'renderRoom', 'renderMembers', 'renderRoomList', 'joinRoom', 'leaveRoom',
    'grantControl', 'updateControlState', 'roomControl', 'closeRoomStream',
    '/events', '/control', '/grant', '/join', 'AbortController', 'getReader',
    'queue-add-batch', 'play-item', 'queue-remove', 'set-mode',
    'openModal', 'closeModal', 'modalRow', 'openAddToPlaylist', 'openCreatePlaylist',
    'applyVolume', 'openPlPanel', 'closePlPanel', 'seekDragging', 'btn-plpanel', 'plpanel-close',
    'showWithFade', 'hideWithFade', 'openCreateRoom', 'openJoinRoom', 'btn-room-join', 'modal-check',
    'btn-back', 'backToSearch', 'renderSearchView', 'lastSearch', 'deleteRoom',
    'showDefaultHome', 'HOME_USER', 'HOME_LIMIT', 'makeTrackRow', 'LIST_CHUNK', 'PLAYLIST_MAX',
    'dissolveRoom', 'removeRoomNow', 'btn-room-dissolve',
    'renderAccount', 'initialsOf', 'acct-avatar', 'acct-avatar2', 'acct-name', 'acct-uid', 'acct-role',
    'transferHost', 'mem-name', 'mem-right',
    'openPlMenu', 'closePlMenu', 'openImportFav', 'menu-create-pl', 'menu-import-pl', 'pl-menu',
    'openRoomPanel', 'closeRoomPanel', 'shareRoom', 'joinFromUrl', 'btn-room-share', 'roompanel-close',
];const lack = need.filter((k) => !js.includes(k));
if (lack.length) fail('缺少关键实现: ' + lack.join(', '));
else console.log('OK   M2+M3+M4+弹窗的关键实现都在（' + need.length + ' 项）');

// ---------- 5. 收藏弹窗不许列管理员的歌单（用户明确要求）----------
const from = js.indexOf('function openAddToPlaylist');
const to = js.indexOf('function openCreatePlaylist');
if (from < 0 || to < from) {
    fail('找不到 openAddToPlaylist 的范围');
} else {
    const picker = js.slice(from, to);
    if (!picker.includes('state.playlists')) fail('收藏弹窗没有用 state.playlists');
    else if (picker.includes('state.shared')) fail('收藏弹窗里出现了 state.shared（管理员歌单不该能当收藏目标）');
    else console.log('OK   收藏弹窗只列 state.playlists，没有引用 state.shared');
}

// ---------- 5b. 邀请码面板只给管理员看（用户明确要求）----------
{
    const a = js.indexOf('function renderAdmin');
    const b = js.indexOf('async function doRevokeInvite', a);
    const body = a >= 0 && b > a ? js.slice(a, b) : '';
    if (!body) fail('找不到 renderAdmin 的范围');
    else if (!/role\s*!==\s*'admin'/.test(body)) fail("renderAdmin 没有检查 role !== 'admin'，邀请码会对所有人显示");
    else console.log('OK   邀请码面板只对管理员显示（renderAdmin 里检查了 role）');
}

// ---------- 5c. 登录/注册：框外要有"哪个框填哪个"，框内不要文字 ----------
{
    // 按大括号配对取函数体（不靠"下一个函数是谁"来猜，函数顺序会变）
    const fnBody = (name) => {
        const at = js.indexOf('function ' + name);
        if (at < 0) return '';
        const open = js.indexOf('{', at);
        if (open < 0) return '';
        let depth = 0;
        for (let i = open; i < js.length; i++) {
            if (js[i] === '{') depth++;
            else if (js[i] === '}') {
                depth--;
                if (depth === 0) return js.slice(open, i + 1);
            }
        }
        return '';
    };
    const login = fnBody('openLoginModal');
    const reg = fnBody('openRegisterModal');
    const labels = (s) => [...s.matchAll(/modalField\(\s*'([^']+)'/g)].map((m) => m[1]);
    const lg = labels(login);
    const rg = labels(reg);
    if (lg.length !== 2) fail('登录弹窗的框外 label 应为 2 个，实际 ' + lg.length);
    else if (rg.length !== 4) fail('注册弹窗的框外 label 应为 4 个，实际 ' + rg.length);
    else if (/placeholder/.test(login) || /placeholder/.test(reg)) fail('登录/注册弹窗的框内不该有 placeholder');
    else console.log('OK   登录 ' + lg.join('/') + '、注册 ' + rg.join('/') + ' 的框外提示都在，框内无文字');
}

// ---------- 6. 已废弃的写法不该复活 ----------
const gone = ['pendingSingle', 'singleClick', 'cancelSingleClick', 'searchItems', 'pickPlaylistId'];
const leftovers = gone.filter((k) => js.includes(k));
if (leftovers.length) fail('旧机制残留: ' + leftovers.join(', '));
else console.log('OK   旧机制已清除');

if (js.includes('new EventSource')) fail('用了 EventSource（带不了 Authorization 头）');
else console.log('OK   没有用 EventSource（改用 fetch + 手写 SSE 解析）');

// ---------- 7. CSS 体检：括号平衡、变量有定义、类名都有样式 ----------
{
    let depth = 0;
    let min = 0;
    for (const ch of css) {
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth < min) min = depth;
        }
    }
    if (depth !== 0 || min < 0) fail('CSS 括号不平衡（结尾 depth=' + depth + '）');
    else console.log('OK   CSS 括号平衡（' + (css.match(/\{/g) || []).length + ' 条规则）');

    const defined = new Set([...css.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
    // 有些变量是 **JS 按元素设的**（`svg.style.setProperty('--icon-size', …)`），
    // 它们只存在于行内样式里，当然不会出现在 <style> —— 也要算"有定义"。
    const fromJs = new Set([...js.matchAll(/setProperty\('--([\w-]+)'/g)].map((m) => m[1]));
    // `var(--x, 兜底值)` 自带兜底 ⇒ 没定义也不会坏（浏览器直接用兜底值）
    const withFallback = new Set([...css.matchAll(/var\(--([\w-]+)\s*,/g)].map((m) => m[1]));
    const usedVars = new Set([...css.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
    const undef = [...usedVars].filter((v) => !defined.has(v) && !fromJs.has(v) && !withFallback.has(v));
    if (undef.length) fail('用了没定义的 CSS 变量: ' + undef.join(', '));
    else console.log('OK   ' + usedVars.size + ' 个 CSS 变量都有定义（或用 JS 设 / 自带兜底值）');

    // JS / HTML 里用到的类名必须真的有样式（防止写了渲染代码却忘了样式）
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hasRule = (c) => new RegExp('\\.' + c.replace(/-/g, '\\-') + '(?![\\w-])').test(selectors);
    const jsClasses = new Set();
    for (const m of js.matchAll(/className\s*=\s*'([^']+)'/g)) m[1].split(/\s+/).forEach((c) => c && jsClasses.add(c));
    for (const m of js.matchAll(/classList\.(?:add|toggle)\('([^']+)'/g)) jsClasses.add(m[1]);
    for (const m of js.matchAll(/className\s*=\s*'([^']*)'\s*\+/g)) m[1].split(/\s+/).forEach((c) => c && jsClasses.add(c));
    // 纯"状态钩子"的类名：只是为了 JS/HTML 能选中/判别状态，
    // 视觉样式来自父级规则或基础 button 样式，本身不需要独立规则。
    // （2026/10/19 重写后这几个是新加的语义类；加样式得先出例图看过再动，不在这里乱加）
    const CLASS_HOOKS = new Set(['host', 'mem-offline', 'ok', 'icon-plus']);
    const missJs = [...jsClasses].filter((c) => !CLASS_HOOKS.has(c) && !hasRule(c));
    if (missJs.length) fail('JS 里用到但 CSS 里没有的类: ' + missJs.join(', '));
    else console.log('OK   JS 用到的 ' + jsClasses.size + ' 个类都有样式（或已登记为状态钩子）');

    const htmlClasses = new Set();
    for (const m of html.slice(0, scriptAt).matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && htmlClasses.add(c));
    const missHtml = [...htmlClasses].filter((c) => !CLASS_HOOKS.has(c) && !hasRule(c));
    if (missHtml.length) fail('HTML 里用到但 CSS 里没有的类: ' + missHtml.join(', '));
    else console.log('OK   HTML 里的 ' + htmlClasses.size + ' 个类都有样式（或已登记为状态钩子）');

    // 旧结构不该复活
    const legacy = ['class="col"', 'id="left"', 'id="right"', 'q-head-row', 'actBtn', 'id="brand"'];
    const found = legacy.filter((n) => html.includes(n));
    if (found.length) fail('旧结构残留: ' + found.join(', '));
    else console.log('OK   没有旧结构残留（.col / #left / #right / q-head-row / actBtn / #brand）');

    // 重复的选择器：改配色时很容易新写一条而忘了删旧的，
    // 两条并存时后面那条赢，排查起来很气人。
    // ⚠️ 但 **@media / @container / @supports 块里的不算重复** —— 那是覆盖，
    //    本来就是同选择器写第二遍（2026/10/16 加窄屏适配时报了 20 处假红；
    //    2026/10/19 重写后又加了 @container 断点，同样要挖掉）。
    //    所以先把这些 at-rule 整块挖掉再数（靠花括号配对，不能靠正则偷懒）。
    let topCss = '';
    {
        const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const AT = /@(media|container|supports)\b/g;
        let i = 0;
        while (i < s.length) {
            AT.lastIndex = i;
            const m = AT.exec(s);
            if (!m) {
                topCss += s.slice(i);
                break;
            }
            topCss += s.slice(i, m.index);
            let depth = 0;
            let j = s.indexOf('{', m.index);
            if (j < 0) break;
            for (; j < s.length; j++) {
                if (s[j] === '{') depth++;
                else if (s[j] === '}') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            i = j + 1;
        }
    }
    const selCount = {};
    for (const m of topCss.matchAll(/(?:^|\})\s*([^{}@]+?)\s*\{/g)) {
        const sel = m[1].trim();
        if (!sel || sel.includes(':root')) continue;
        selCount[sel] = (selCount[sel] || 0) + 1;
    }
    const dups = Object.entries(selCount).filter(([, n]) => n > 1);
    if (dups.length) fail('CSS 里有重复的选择器: ' + dups.map(([s, n]) => s + '(' + n + '次)').join(', '));
    else console.log('OK   没有重复的 CSS 选择器（@media / @container 里的覆盖不算）');

    // 页面上不该出现站名（用户明确要求删掉左上角的名字）
    // 注意 <title> 和 localStorage 的 'hnmusic_token' 不算，所以只看 <body> 到 <script> 之间的部分
    const bodyHtml = html.slice(html.indexOf('<body>'), scriptAt);
    if (bodyHtml.includes('hnmusic')) fail('页面上又出现站名 hnmusic 了（用户要求删掉）');
    else console.log('OK   页面上没有站名 hnmusic（只在 <title> 和 localStorage 键名里还有）');

    // #top 是 grid（2026/10/19 重写后是【音乐库按钮 | 搜索 | 右侧账号】三列）。
    // 原来这条盯的是子元素要写 grid-column，否则只有两个子元素时会自动落到第 1、2 列
    // （搜索框贴左、账号跑到中间 —— 2026/10/15 真出过这个 bug）。
    // 现在是三列显式模板 + 右侧靠右，所以改成查这三件事，比盯 grid-column 更贴合现状。
    {
        const ruleOf = (sel) => {
            const i = css.indexOf(sel + ' {');
            if (i < 0) return '';
            return css.slice(i, css.indexOf('}', i));
        };
        const top = ruleOf('#top');
        const bar = ruleOf('#bar');
        const right = ruleOf('.top-right');
        const cols = ((top.match(/grid-template-columns:([^;]+);/) || [])[1] || '').trim();
        const tracks = cols ? cols.split(/\s+/) : [];
        if (!top) fail('找不到 #top 的样式');
        else if (!/display:\s*grid/.test(top)) fail('#top 不再是 grid（顶栏对齐会散）');
        else if (tracks.length < 3) fail('#top 的 grid-template-columns 少于 3 列（搜索框会贴到左边）: ' + cols);
        else if (!bar) fail('找不到 #bar 的样式');
        else if (!/width:\s*100%/.test(bar)) fail('#bar 没有撑满中间那一列');
        else if (!right) fail('找不到 .top-right 的样式');
        else if (!/justify-content:\s*flex-end/.test(right)) fail('.top-right 没有靠右（账号区会跑到中间）');
        else console.log('OK   顶栏三列布局：#bar 撑满中间列、.top-right 靠右');
    }
}

// ---------- 8b. public/ 里不许留探针页 / 备份页 ----------
// 2026/10/16 定的规矩（§51）：探针页跑完就删掉，别留在 public/ 里跟着上线。
// 2026/10/19 清了一轮：index-new.html / index.backup-*.html / _cp.html / _storm.html ——
// 它们都是**能被公网直接访问**的（/index-new.html 这种），等于把半成品和旧版挂出去。
// 这条断言只在检查项目自带的 public/index.html 时生效（拿别的文件做坏副本时不误报）。
{
    const PUB = path.join(HERE, '..', 'public');
    const isDefaultTarget = path.resolve(target) === path.resolve(path.join(PUB, 'index.html'));
    if (isDefaultTarget) {
        const allowed = new Set(['index.html']);
        const strays = fs.readdirSync(PUB).filter((n) => {
            if (allowed.has(n)) return false;
            const full = path.join(PUB, n);
            return fs.statSync(full).isFile(); // 目录（如 assets/）不算
        });
        if (strays.length) fail('public/ 里有不该上线的散页/备份（能被公网直接访问）: ' + strays.join(', '));
        else console.log('OK    public/ 是干净的（只有 index.html + 资源目录，没有探针/备份页）');
    }
}

// ---------- 9. HTML 结构计数（防止编辑时插重）----------
[
    ['</body>', 1],
    ['</html>', 1],
    ['id="modal"', 1],
    ['id="account"', 1],
    ['id="admin-box"', 1],
    ['id="plpanel"', 1],
    ['id="q-list"', 1],
    ['id="side"', 1],
    ['id="roompanel"', 1],
].forEach(([needle, want]) => {
    const n = html.split(needle).length - 1;
    if (n !== want) fail(needle + ' 出现 ' + n + ' 次，应为 ' + want + ' 次');
});
console.log('OK   HTML 结构计数正常（……#side / #roompanel / #plpanel 各一份，#q-list 只有一处）');

// ---------- 9. 淡入淡出：三个浮层都得有 .show 过渡，且不能用 hidden 直接切 ----------
{
    const needShow = ['#modal', '#plpanel', '#account'];
    const miss = needShow.filter((sel) => {
        const i = css.indexOf(sel + '.show');
        return i < 0 || !/opacity|transform/.test(css.slice(i, css.indexOf('}', i)));
    });
    if (miss.length) fail('这些浮层没有淡入淡出的 .show 过渡: ' + miss.join(', '));
    else console.log('OK   #modal / #plpanel / #account 都有 .show 过渡');

    // 关闭必须走 hideWithFade，不能直接 el.hidden = true（那样是瞬间消失，没淡出）
    const directHides = [...js.matchAll(/\$\('(modal|plpanel|account)'\)\.hidden\s*=\s*true/g)].map((m) => m[1]);
    if (directHides.length) fail('这些地方直接设了 hidden=true，会没有淡出效果: ' + directHides.join(', '));
    else console.log('OK   没有直接设 hidden=true 的地方（关闭都走 hideWithFade）');
}

// ---------- 10. 搜索框只能由用户填写 ----------
// 用户要求过两次："搜索栏默认为空"。默认搜索（VOCALOID）和【返回】
// 都是程序发起的，绝不该往框里塞字 —— 一旦有人加回 $('q').value = q，
// 打开页面就会看到框里被自动填了 VOCALOID。
{
    const writes = [...js.matchAll(/\$\('q'\)\.value\s*=\s*[^=]/g)];
    if (writes.length) {
        fail("搜索框被程序写了 " + writes.length + ' 处（用户要求默认为空）：' + JSON.stringify(writes.map((m) => m[0])));
    } else {
        console.log('OK   没有程序往搜索框里填字（默认搜索 / 返回 都不动它）');
    }
}
// ---------- 11. 文字对比度 ----------
// 配色已经来回改过六次，每次都有把字改成看不清的风险
// （比如深色播放条上用深色字、浅色底上用浅灰字）。这里按 WCAG 算对比度。
{
    const rootCss = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    const V = {};
    for (const m of rootCss.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) V[m[1]] = m[2];
    const lum = (hex) => {
        const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
        const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
        const s = [lum(a), lum(b)].sort((m, n) => n - m);
        return (s[0] + 0.05) / (s[1] + 0.05);
    };
    const pairs = [
        ['fg/card', 'fg', 'card', 4.5],
        ['fg2/card', 'fg2', 'card', 4.5],
        ['fg3/card', 'fg3', 'card', 3.0],
        ['accent-dim/card', 'accent-dim', 'card', 4.5],
        ['top-fg/top-bg', 'top-fg', 'top-bg', 4.5],
        ['top-fg2/top-bg', 'top-fg2', 'top-bg', 4.5],
        ['player-fg/player-bg', 'player-fg', 'player-bg', 4.5],
        ['player-fg2/player-bg', 'player-fg2', 'player-bg', 4.5],
        ['player-fg3/player-bg', 'player-fg3', 'player-bg', 3.0],
        ['fg/sel', 'fg', 'sel', 4.5],
        ['accent-dim/sel', 'accent-dim', 'sel', 3.0],
    ];
    const weak = [];
    for (const [name, f, b, need] of pairs) {
        if (!V[f] || !V[b]) continue;
        const r = ratio(V[f], V[b]);
        if (r < need) weak.push(name + ' ' + r.toFixed(2) + ':1(需' + need + ')');
    }
    if (weak.length) fail('文字对比度不够: ' + weak.join('  '));
    else console.log('OK   文字对比度全部达标（' + pairs.length + ' 组：主体 / 顶栏 / 播放条 / 选中行）');
}

// ---------- 12. 前端逻辑小测（房间列表）----------
// 做法：给脚本尾巴追加一句 return，把内部函数掏出来，然后在假 DOM 上直接调。
// 这样不用浏览器也能测"渲染出来是什么"，正好覆盖用户报过的那个 bug：
// 人在房间里，右栏却还挂着"（没有进行中的房间）"。
{
    const badBefore = bad;
    const harness =
        js +
        `
    return {
        renderRoomList,
        _setRoom: (r) => { room = r; },
        _setRooms: (rs) => { openRooms = rs; },
        _setMe: (m) => { me = m; },
        _list: (id = 'room-list') => document.getElementById(id),
    };`;
    let api = null;
    try {
        api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            () => new Promise(() => {}),
            { clipboard: undefined },
            fakeWindow,
            () => 0
        );
    } catch (e) {
        fail('掏前端内部函数失败: ' + e.message);
    }
    if (api) {
        const textOf = (el) => {
            let s = String(el.textContent || '');
            for (const c of el.children || []) s += textOf(c);
            return s;
        };
        // A. 不在房间里、也没有房间 → 该显示占位
        api._setMe({ role: 'user' });
        api._setRoom(null);
        api._setRooms([]);
        api.renderRoomList();
        let kids = api._list().children;
        if (kids.length !== 1 || !textOf(kids[0]).includes('没有进行中的房间')) {
            fail('不在房间里又没有房间时，房间列表应显示占位，实际 ' + kids.length + ' 项');
        }
        // B. 在房间里、是**管理员**、没有别的房间 → 不该再有占位（用户报的就是这个）
        //    ⚠️ 必须用管理员测：普通用户在房间里会被函数开头那条
        //    `if (room && !isAdmin) return` 拦掉，压根走不到占位那句，
        //    拿 user 去测等于什么都没测（我第一版就是这么写错的，白测了一场）
        api._setMe({ role: 'admin' });
        api._setRoom({ roomId: 'r1', name: '我的房' });
        api._setRooms([]);
        api.renderRoomList();
        kids = api._list().children;
        if (kids.length !== 0) {
            fail('人在房间里时房间列表还是渲染了 ' + kids.length + ' 项：「' + textOf(kids[0]).slice(0, 30) + '」');
        }
        // B2. 在房间里、是普通用户 → 同样不该渲染任何东西
        api._setMe({ role: 'user' });
        api.renderRoomList();
        if (api._list().children.length !== 0) fail('普通用户在房间里时房间列表不该有内容');
        // C. 在房间里、有别的房间（管理员）→ 列出别人那间，不列自己那间
        api._setMe({ role: 'admin' });
        api._setRooms([
            { roomId: 'r1', name: '我的房', members: 1 },
            { roomId: 'r2', name: '别人的房', members: 3 },
        ]);
        api.renderRoomList();
        kids = api._list().children;
        const all = kids.map(textOf).join('|');
        if (kids.length !== 1 || !all.includes('别人的房') || all.includes('我的房')) {
            fail('在房间里时列表应只列别人的房，实际「' + all + '」');
        }
        if (bad === badBefore) console.log('OK   房间列表的四条规则都对（不在房间显示占位 / 管理员在房间不显示 / 普通用户在房间不显示 / 只列别人的房）');
    }
}// ---------- 13. 前端逻辑小测（首页默认视图）----------
// 首页现在是"某个 B 站用户的默认收藏夹前 20 首"（以前是搜 VOCALOID）。
// 它是打开页面第一眼看到的东西，坏了整个应用看着就是空的，所以单独测一下：
// 把 fetch 换成固定返回，调 showDefaultHome()，看列表和说明文字有没有正确渲染。
{
    const badBefore = bad;
    const harness =
        js +
        `
    return {
        showDefaultHome,
        _list: (id) => document.getElementById(id),
        _meta: () => document.getElementById('meta'),
    };`;
    const items = Array.from({ length: 20 }, (_, i) => ({
        bvid: 'BVtest' + i,
        title: '测试歌 ' + (i + 1),
        author: '某 UP',
        duration: 100 + i,
        cover: '',
    }));
    const fakeFetch = makeApiStub({
        // 2026/10/19：首页改成一次请求 /api/home（cards = 最新收藏，items = 每日精选）
        '/api/home': {
            user: { mid: '17800413', name: '灰诺-' },
            folder: { mediaId: '1', title: '默认收藏夹', count: 4843 },
            cards: items.slice(0, 6),
            items,
        },
        // 老接口留着当兜底（前端在 /api/home 404 时会退回它）
        '/api/bili/fav-preview': { user: { mid: '17800413', name: '灰诺-' }, folder: { mediaId: '1', title: '默认收藏夹', count: 4843 }, items },
    });
    let api = null;
    try {
        api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            fakeFetch,
            { clipboard: undefined },
            fakeWindow,
            () => 0
        );
    } catch (e) {
        fail('掏首页函数失败: ' + e.message);
    }
    if (api) {
        try {
            await api.showDefaultHome();
        } catch (e) {
            fail('showDefaultHome 抛错: ' + e.message);
        }
        const rows = api._list('list').children;
        if (rows.length !== 20) fail('首页应该渲染 20 行，实际 ' + rows.length);
        const head = api._list('list-head');
        if (head.hidden === true) fail('首页有 20 行时列头不该隐藏');
        const meta = String(api._meta().textContent);
        // ⚠️ 用户 2026/10/15 明确要求**不要**显示那行说明：
        //    「灰诺- 的「默认收藏夹」（共 4843 首）· 这是最新的 20 首」。
        //    列表本身已经说明一切，那行只是噪音；取数失败时才写 #meta（那是必要的报错）。
        if (meta !== '') fail('首页成功时 #meta 应该是空的（用户要求不要那行说明），实际：「' + meta + '」');
        // 管理员专属的「刷新收藏夹」按钮要存在（点了会带 fresh=1 绕过缓存）
        const rehome = js.match(/\$\('btn-rehome'\)\.addEventListener\('click'/);
        if (!rehome) fail('缺少「刷新收藏夹」按钮的事件绑定');
        if (!/showDefaultHome\(true\)/.test(js)) fail('「刷新收藏夹」没有走 fresh 模式（还是拿缓存）');
        if (bad === badBefore) console.log('OK   首页默认视图渲染正常（20 行，且没有那行说明文字；管理员有「刷新收藏夹」按钮）');
    }
}

// ---------- 14. 导入弹窗：框内干净，但"UID 也能搜"必须让用户知道 ----------
// 2026/10/15 用户要求把框内的示例文字删掉（"算了你把框内的字删掉"）。
// 那就只剩框外那个 label 在告诉用户 UID 也能搜 —— 所以 label 绝对不能在。
// 后端 bili.parseUid 认 uid<数字> / space 链接 / 纯数字（见 scripts/check-bili.mjs）。
// ⚠️ 注意这些都写在 <script> 里，要查 js 而不是 head（我第一版就写错了，真文件直接红）
{
    const badBefore = bad;
    if (/placeholder:/.test(js)) {
        fail('导入弹窗的输入框不该有 placeholder（用户要求删掉框内的字）');
    }
    if (!/modalField\('B 站用户名 或 UID'/.test(js)) {
        fail('导入弹窗的 label 要写明「B 站用户名 或 UID」，否则用户不知道 UID 也能搜');
    }
    if (bad === badBefore) console.log('OK   导入弹窗：框内没有示例文字，label 写明了「用户名 或 UID」');
}

// ---------- 15. 操作反馈与双击语义（2026/10/15 用户反馈的一组 bug）----------
// 用户原话：「播放列表不能双击播放」「双击加队列最下还是有点卡手」
//           「加入队列和下一首无法正常响应」「加入队列改成加入列表」
// 查出来的三个真 bug：
//   ① enqueue() 成功时完全没有提示（只有"重复"才 hint），
//      而唯一的高亮 flashQueueItem 作用在**关着的**面板里的行上
//      → 用户点了什么都看不见，以为"没反应"
//   ② playPlaylistItem() 遇到"已经在队列里"直接 return，不播
//      → 歌单里双击一首已经在队列里的歌，没反应
//   ③ ▶ 按钮：audio 没 src 就一律说"队列里还没有歌"，
//      可队列是从服务端恢复的、里面明明有歌
{
    const badBefore = bad;
    // ① 提示必须同时弹浮层（只写 #now 会被 playMedia 的状态覆盖掉）
    //    ⚠️ 别把断言绑死在某次实现的变量名上 —— 我第一版查的是 `showWithFade(el)`，
    //       后来把变量改名成 t，行为没变却被判红了
    if (!/id="toast"/.test(head)) fail('#toast 浮层不存在 —— 提示只写 #now 会被播放状态覆盖掉');
    {
        const hintBody = (js.match(/function hint\([\s\S]*?\n    \}/) || [''])[0];
        if (!hintBody) fail('找不到 hint() 函数体');
        else {
            if (!/toast/.test(hintBody)) fail('hint() 没有用到 #toast 浮层（提示会只留在播放条那行小字上）');
            if (!/showWithFade\(/.test(hintBody)) fail('hint() 没有把浮层显示出来');
            // 播放条那行提示要**自己消失**，否则会一直挂着
            //（用户截图里"播放模式：顺序播放"就永远留在那儿）
            if (!/setTimeout\(/.test(hintBody) || !/textContent = ''/.test(hintBody)) {
                fail('hint() 没有给播放条那行加自动清除（提示会一直挂着）');
            }
        }
    }
    // ② 双击 = 排到下一首**并播放**。
    //    ⚠️ 要正面断言"它走了 playNext"，别只查"不是 enqueue(info,false)" ——
    //       我第一版就是那样，改成 enqueue(info,true)（只排队不播）照样通过（假绿）
    if (!/async function playNext/.test(js)) fail('缺少 playNext()（双击应该排到下一位并马上播）');
    {
        const dbl = (js.match(/async function addSearchResultToQueue\(bvid\) \{[\s\S]*?\n    \}/) || [''])[0];
        if (!dbl) fail('找不到 addSearchResultToQueue（搜索结果的双击处理）');
        else if (!/playNext\(/.test(dbl)) {
            fail('双击搜索结果没走 playNext（双击应该排到下一首并马上播，不是只排队）');
        }
    }
    // ②′ 【下一首】按钮 = **只插到下一首，不打断当前播放**。
    //     用户 2026/10/15 问：「为什么点击下一首是直接播放」——
    //     我之前把按钮和双击合并成了同一个动作，但按钮叫"下一首"，
    //     读起来就是个排队动作。要立刻听这首是**双击**。
    {
        const nextBtn = (js.match(/dataset\.act === 'next'\)[^\n]*/) || [''])[0];
        if (!nextBtn) fail('找不到【下一首】按钮的处理');
        else if (!/enqueue\(info, true\)/.test(nextBtn)) {
            fail('【下一首】不是"只插到下一首"（点了会打断正在放的歌）: ' + nextBtn.trim().slice(0, 60));
        }
        if (/dataset\.act === 'next'\)[^\n]*playNext\(/.test(js)) {
            fail('【下一首】又调回 playNext 了（会直接切歌）');
        }
    }
    // ③ 歌单双击不能再被"重复"挡掉
    if (/playPlaylistItem\(item\)\s*\{[\s\S]{0,700}if \(duplicate\) return;/.test(js)) {
        fail('playPlaylistItem 还在"已经在队列里就直接 return"，双击会没反应');
    }
    // ④ 文案
    if (/'加入队列'/.test(js)) fail('按钮文案还有「加入队列」，用户要求改成「加入列表」');
    if (!/'加入列表'/.test(js)) fail('找不到「加入列表」按钮文案');
    // ⑤ ▶ 不能在队列非空时骗用户说没有歌。
    //    原始 bug 就是这一行：if (!a.getAttribute('src')) return hint('队列里还没有歌');
    //    ⚠️ 只匹配 hint(...) 这种**代码形式**，别匹配到注释里提到的那句话
    //    （我第一版就是匹配裸字符串，结果自己注释里的引用把真文件判红了）
    if (/hint\('队列里还没有歌'\)/.test(js)) {
        fail('▶ 按钮又在说"队列里还没有歌"了 —— 队列是从服务端恢复的，里面明明有歌');
    }
    if (!/playQueueItem\(cur\)/.test(js)) {
        fail('▶ 在"没加载过但队列里有歌"时要去播队列当前那首（playQueueItem(cur) 不见了）');
    }
    if (bad === badBefore) console.log('OK    操作反馈（浮层）+ 双击=排下一首并播 + 【下一首】=只排队；按钮文案是「加入列表」');
}

// ---------- 16. 歌单页头（照用户给的稿子：大封面 + 标题 + 作者/时间 + 按钮）----------
// 2026/10/15 用户要求"把歌单页面上面改成类似这样的 ui"（给了网易云/B站那种页头稿子）。
// 这里断言页头真的被填满 —— 少填一个字段就会露出空白，很难靠肉眼发现
{
    const badBefore = bad;
    const harness =
        js +
        `
    return {
        openPlaylist,
        _el: (id) => document.getElementById(id),
    };`;
    const fakePl = {
        id: 'p1',
        name: '灰诺严选',
        ownerId: 'u40',
        ownerName: 'huino',
        canEdit: true,
        cover: 'http://i0.hdslb.com/bfs/archive/abc.jpg',
        createdAt: 1755738000000, // 2026-08-21
        items: [
            { id: 'i1', bvid: 'BV1', cid: '1', title: '歌一', cover: 'http://x/1.jpg', duration: 100, author: 'A' },
            { id: 'i2', bvid: 'BV2', cid: '2', title: '歌二', cover: 'http://x/2.jpg', duration: 120, author: 'B' },
        ],
    };
    const fakeFetch = makeApiStub({ '/api/playlists/': fakePl });
    let api = null;
    try {
        api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            fakeFetch,
            { clipboard: undefined },
            fakeWindow,
            () => 0
        );
    } catch (e) {
        fail('掏 openPlaylist 失败: ' + e.message);
    }
    if (api) {
        try {
            await api.openPlaylist('p1');
        } catch (e) {
            fail('openPlaylist 抛错: ' + e.message);
        }
        const el = api._el;
        if (el('pl-head').hidden === true) fail('歌单页头没显示出来');
        if (el('pl-title').textContent !== '灰诺严选') fail('页头标题不对: ' + el('pl-title').textContent);
        if (!el('pl-cover').src) fail('页头大封面没设 src');
        // 模糊底色是把封面喂给 CSS 变量做到的，漏了就成了死板的灰底
        const bg = el('pl-head').style.getPropertyValue('--pl-cover');
        if (!bg || !bg.includes('url(')) fail('页头没把封面喂给 --pl-cover（模糊底色会没有）');
        if (!el('pl-avatar').textContent) fail('页头作者头像（首字）没填');
        if (el('pl-owner').textContent !== 'huino') fail('页头作者名不对: ' + el('pl-owner').textContent);
        if (!/2 首/.test(el('pl-num').textContent)) fail('页头首数不对: ' + el('pl-num').textContent);
        if (!/\d{4}-\d{2}-\d{2} 创建/.test(el('pl-created').textContent)) {
            fail('页头建单时间不对（要 YYYY-MM-DD 创建）: ' + el('pl-created').textContent);
        }
        if (el('pl-created').hidden === true) fail('有建单时间却把它藏了');
        // 三个操作按钮要排在**右边**（用户 2026/10/15 要求）。
        // 靠 CSS 的 flex + margin-left:auto，前提是它在 HTML 里和 .pl-info **平级**；
        // 一旦被塞回 .pl-info 里，就又跑到标题下面去了。
        // 判断法：.pl-info 和 .pl-acts 之间的 </div> 至少要 2 个
        //（1 个关 .pl-meta，1 个关 .pl-info）—— 只有 1 个就说明 .pl-acts 嵌在 .pl-info 里
        const iInfo = head.indexOf('class="pl-info"');
        const iActs = head.indexOf('class="pl-acts"');
        if (iInfo < 0 || iActs < 0) {
            fail('找不到 .pl-info 或 .pl-acts（页头结构被改了？）');
        } else {
            if (iActs < iInfo) fail('三个按钮要排在作者信息之后（现在跑到前面了）');
            const between = head.slice(iInfo, iActs);
            const closes = (between.match(/<\/div>/g) || []).length;
            if (closes < 2) fail('三个按钮嵌在 .pl-info 里了 —— 要平级才会排到右边（当前之间只有 ' + closes + ' 个 </div>）');
        }
        if (bad === badBefore) console.log('OK   歌单页头字段齐全（封面/标题/作者/首数/时间/模糊底色），三个按钮排在右边');
    }
}

// ---------- 17. 「灰诺推荐」这一栏 ----------
// 用户 2026/10/15 要求：别人看到我的歌单时，那栏别叫「大家的歌单」，叫「灰诺推荐」。
// 这个字符串有两处（HTML 里做默认值 + JS 常量覆盖），最容易改一处漏一处，所以断言两处一致。
{
    const badBefore = bad;
    const m = js.match(/const RECOMMEND_TITLE = '([^']+)'/);
    if (!m) {
        fail('找不到 RECOMMEND_TITLE 常量（侧栏"推荐"栏的名字）');
    } else {
        if (m[1] !== '灰诺推荐') fail('RECOMMEND_TITLE 应该是「灰诺推荐」，现在是「' + m[1] + '」');
        const inHtml = (head.match(/<span id="shared-title">([^<]*)<\/span>/) || [])[1];
        if (inHtml === undefined) fail('HTML 里找不到 #shared-title');
        else if (inHtml !== m[1]) fail('#shared-title 的默认值（' + inHtml + '）和 RECOMMEND_TITLE（' + m[1] + '）不一致');
    }
    if (/大家的歌单/.test(head)) fail('侧栏还留着「大家的歌单」这个旧标题');
    if (bad === badBefore) console.log('OK    侧栏推荐栏叫「灰诺推荐」（HTML 默认值和 JS 常量一致）');
}

// ---------- 18. 页脚备案号位（个人中心底部）----------
// 备案号必须在网站上展示。现在先留好位置：ICP_LICENSE 为空 → 整行隐藏（看不见），
// 填上 → 出现一个指向工信部的链接。这样备案下来只改一行字符串，不用再动别的代码。
// ⚠️ 这里**真的跑一遍** renderAccount() 看行为 ——
//    只 grep 常量在不在是弱测试（我第一版就是那样，等于没测）
{
    const badBefore = bad;
    // 用假 DOM 跑：登录一个管理员 → 调 renderAccount()
    const runAccount = async (source, fetchImpl) => {
        const harness =
            source +
            `
    return {
        loadMe,
        renderAccount,
        _el: (id) => document.getElementById(id),
    };`;
        const api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            fetchImpl,
            { clipboard: undefined },
            fakeWindow,
            () => 0
        );
        await api.loadMe();
        api.renderAccount();
        return api;
    };
    const userResp = (u) => makeApiStub({ '/api/auth/me': { session: { sid: 's1' }, user: u } });
    const admin = { id: 'u1', username: 'huinuo', displayName: '灰诺', role: 'admin' };

    // ① 常量空着 → 整行必须隐藏（否则个人中心底部会出现一条空白，看着像 bug）
    try {
        const a = await runAccount(js, userResp(admin));
        const el = a._el('icp');
        if (el.hidden !== true) fail('ICP_LICENSE 为空时 #icp 应该隐藏（现在是显示的，会留一条空白）');
        if (el.children.length) fail('ICP_LICENSE 为空时不该往里塞东西');
    } catch (e) {
        fail('空备案号那次 renderAccount 抛错: ' + e.message);
    }

    // ② 填上备案号 → 必须显示，而且是个能点回工信部的链接
    const code = '沪ICP备2026000000号';
    const filled = js.replace(/const ICP_LICENSE = ''/, "const ICP_LICENSE = '" + code + "'");
    if (filled === js) {
        fail('改不动 ICP_LICENSE（锚点失效，这个测试就没意义了）');
    } else {
        try {
            const b = await runAccount(filled, userResp(admin));
            const el = b._el('icp');
            if (el.hidden === true) fail('填了备案号却还是隐藏的');
            const link = el.children[0];
            if (!link) fail('填了备案号但没生成链接');
            else {
                if (link.textContent !== code) fail('备案号文字不对: ' + link.textContent);
                if (!/beian\.miit\.gov\.cn/.test(link.href || '')) fail('备案号没链回工信部: ' + link.href);
            }
        } catch (e) {
            fail('填了备案号那次 renderAccount 抛错: ' + e.message);
        }
    }
    if (!/id="icp"/.test(head)) fail('HTML 里找不到 #icp 页脚元素');
    if (bad === badBefore) console.log('OK    页脚备案号：空着时隐藏，填上后显示成工信部链接（真跑了一遍）');
}

// ---------- 19. 封面必须带 B 站缩放后缀（性能关键，别退化）----------
// 2026/10/15 朋友反馈"太卡了"，实测根因不是带宽不够（音频只占 103kbps、
// 中转实测能跑 2.7Mbps），而是**封面原图太大**：
//     同一张封面原图 672KB，加 @120w_120h_1c.webp 后 3KB
//     一页 20 张封面：13.1MB → 46KB（实测）
// 13MB 在 3Mbps 的机器上要下三十多秒，还会把音频挤断 —— 这就是"卡"。
// 所以这条要**真调函数**验证，不能只 grep。
{
    const badBefore = bad;
    const harness =
        js +
        `
    return { coverSrc, withCoverSize };`;
    let api = null;
    try {
        api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            makeApiStub(),
            { clipboard: undefined },
            fakeWindow,
            () => 0
        );
    } catch (e) {
        fail('掏 coverSrc 失败: ' + e.message);
    }
    if (api) {
        const { coverSrc, withCoverSize } = api;
        // ⚠️ coverSrc 会把地址 encodeURIComponent，`@` 会变成 %40 ——
        // 断言前先解码（我第一版就是没解码，结果真文件被误判成红了）
        const dec = (s) => decodeURIComponent(String(s || ''));
        // ① 列表行默认要带后缀
        const row = coverSrc('https://i0.hdslb.com/bfs/archive/abc.jpg');
        if (!/@96w_96h_1c\.webp/.test(dec(row))) fail('列表封面没带缩放后缀（会退回 672KB 原图）: ' + dec(row));
        if (!row.startsWith('/proxy?url=')) fail('封面没走 /proxy: ' + row);
        // ② 页头要用大图（页头展示 128px，2 倍图 ⇒ 至少 288；现在是 360，够）
        {
            const heroUrl = dec(coverSrc('https://i0.hdslb.com/a.jpg', 'hero'));
            const mHero = heroUrl.match(/@(\d+)w_\1h_1c\.webp/);
            if (!mHero) fail('页头封面没加 B 站缩放后缀: ' + heroUrl);
            else if (Number(mHero[1]) < 288) fail('页头封面尺寸太小（' + mHero[1] + '，至少要 288）: ' + heroUrl);
        }
        // ③ 后缀要贴在查询串**前面**（贴后面 B 站不认）
        const q = withCoverSize('https://i0.hdslb.com/a.jpg?x=1', 96);
        if (q !== 'https://i0.hdslb.com/a.jpg@96w_96h_1c.webp?x=1') fail('后缀位置不对: ' + q);
        // ④ 已经带后缀的别叠第二个
        const dup = withCoverSize('https://i0.hdslb.com/a.jpg@320w_320h_1c.webp', 96);
        if (dup !== 'https://i0.hdslb.com/a.jpg@320w_320h_1c.webp') fail('后缀叠了两层: ' + dup);
        // ⑤ 空封面不能造出 /proxy?url= （那会去请求页面自己）
        if (coverSrc('') !== '') fail('空封面应该返回空串');
        // ⑥ 必须有加载失败的兜底（退回原图），别留个裂图
        if (!/function fadeToRawCover/.test(js)) fail('缺少封面加载失败的兜底（fadeToRawCover）');
        if (bad === badBefore) console.log('OK    封面带 B 站缩放后缀（一页 20 张：13MB → 46KB），且有失败兜底');
    }
}

// ---------- 20. 【一起听】按钮对游客也要有 ----------
// 用户 2026/10/15 截图：无痕窗口（游客）下顶栏只有【登录】【注册】，
// **完全没有进一起听的入口** —— 连别人发来的邀请链接都点不进去。
// 后端其实一直允许游客建房/进房（用 's:<sid>' 认身份，14 项测试验证过），
// 纯粹是 renderAuth() 把按钮写在"已登录"分支里了。
{
    const badBefore = bad;
    const harness =
        js +
        `
    return { renderAuth, loadMe, _el: (id) => document.getElementById(id) };`;
    const build = (fetchImpl) =>
        new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            fetchImpl,
            { clipboard: undefined },
            fakeWindow,
            () => 0
        );
    // 2026/10/19 重写后【一起听】是个**纯图标按钮**（没有文字，标题/title 才是"一起听"），
    // 所以按 aria-label / aria-controls 认，不能按 textContent 认（那样永远认不到）。
    const hasRooms = (authEl) =>
        (authEl.children || []).some((c) => {
            const a = c.attrs || {};
            return a['aria-label'] === '一起听' || a['aria-controls'] === 'roompanel';
        });
    // 顶栏的文字要连子节点一起取（按钮里是"图标 + 文字"两个子节点，textContent 本身是空）
    const textOf = (el) => String(el.textContent || '') + (el.children || []).map(textOf).join('');
    const textsOf = (authEl) => (authEl.children || []).map(textOf);

    // ① 游客（me === null）：必须能看到【一起听】
    try {
        const guest = build(makeApiStub({ '/api/auth/me': { session: null, user: null } }));
        await guest.loadMe(); // 游客身份：user 为 null
        guest.renderAuth();
        const t = textsOf(guest._el('auth'));
        if (!hasRooms(guest._el('auth'))) fail('游客顶栏里没有【一起听】按钮 —— 游客就完全进不去一起听了（当前只有: ' + t.join(' / ') + '）');
        if (!t.includes('登录') || !t.includes('注册')) fail('游客顶栏应该还有【登录】【注册】: ' + t.join(' / '));
    } catch (e) {
        fail('游客那次 renderAuth 抛错: ' + e.message);
    }

    // ② 已登录：用户名 + 【一起听】，而且【一起听】也得在
    try {
        const user = build(
            makeApiStub({
                '/api/auth/me': { session: { sid: 's1' }, user: { id: 'u1', username: 'huinuo', displayName: '灰诺', role: 'admin' } },
            })
        );
        await user.loadMe();
        user.renderAuth();
        const t = textsOf(user._el('auth'));
        if (!hasRooms(user._el('auth'))) fail('已登录顶栏里没有【一起听】: ' + t.join(' / '));
        if (!t.some((x) => x.includes('灰诺'))) fail('已登录顶栏没显示用户名: ' + t.join(' / '));
        if (t.includes('登录') || t.includes('注册')) fail('已登录不该还显示【登录】【注册】: ' + t.join(' / '));
    } catch (e) {
        fail('已登录那次 renderAuth 抛错: ' + e.message);
    }
    if (bad === badBefore) console.log('OK    【一起听】按钮对游客和登录用户都显示（游客也能建房/进房）');
}

// ---------- 21. 房间队列要能调整顺序 ----------
// 用户 2026/10/15：进了房间发现"没办法调整歌曲列表"，要求至少能排到下一首。
// 我自己的队列一直有 ↑/↓，房间队列只有 ▶ 和 ✗ —— 这是真缺口。
// 规则：自己加的曲子（或房主）才能挪；挪动只改顺序，不打断正在播的那首。
{
    const badBefore = bad;
    const harness =
        js +
        `
    return {
        applyRoomState,
        renderQueue,
        _rows: () => (document.getElementById('q-list').children || []),
    };`;
    let api = null;
    try {
        api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            makeApiStub(),
            { clipboard: undefined },
            fakeWindow,
            () => 0
        );
    } catch (e) {
        fail('掏 renderQueue 失败: ' + e.message);
    }
    if (api) {
        const actsOf = (li) => {
            const acts = (li.children || []).find((c) => c.className === 'acts');
            return acts ? (acts.children || []).map((b) => (b.dataset && b.dataset.act) || '') : [];
        };
        // 我是普通成员（不是房主、没有控制权），房里有"我加的"和"别人加的"各一首
        const roomState = {
            roomId: 'r1',
            name: '测试房',
            hostId: 's:someoneelse',
            isPrivate: false,
            isPlaying: false,
            anchorPosition: 0,
            anchorServerTime: Date.now(),
            members: [
                { key: 's:me', name: '我', isHost: false },
                { key: 's:someoneelse', name: '别人', isHost: true },
            ],
            controllerIds: [],
            you: { key: 's:me', isHost: false, canControl: false },
            queue: {
                mode: 'sequence',
                currentId: 'i1',
                items: [
                    { id: 'i1', bvid: 'BV1', cid: '1', title: '我加的', addedBy: 's:me', duration: 100, cover: '' },
                    { id: 'i2', bvid: 'BV2', cid: '2', title: '别人加的', addedBy: 's:someoneelse', duration: 100, cover: '' },
                ],
            },
        };
        try {
            api.applyRoomState(roomState, false);
            const rows = api._rows();
            if (rows.length !== 2) fail('房间队列应该渲染 2 行，实际 ' + rows.length);
            else {
                const mine = actsOf(rows[0]);
                const theirs = actsOf(rows[1]);
                // 自己加的：下一位 / ↑ / ↓ / ✗
                for (const need of ['rnext', 'rup', 'rdown', 'rdel']) {
                    if (!mine.includes(need)) fail('自己加的曲子缺少【' + need + '】按钮（当前: ' + mine.join(',') + '）');
                }
                // 没有控制权就不该有"切到这首"
                if (mine.includes('rplay')) fail('没有控制权却出现了【切到这首】');
                // 别人加的：不该能挪、不该能删
                if (theirs.includes('rnext') || theirs.includes('rup') || theirs.includes('rdown')) {
                    fail('别人加的曲子不该能调整顺序（当前: ' + theirs.join(',') + '）');
                }
                if (theirs.includes('rdel')) fail('别人加的曲子不该能删（非房主）');
            }
        } catch (e) {
            fail('渲染房间队列抛错: ' + e.message);
        }
        if (bad === badBefore) console.log('OK    房间队列：自己加的曲子有【下一位 / ↑ / ↓ / ✗】，别人的不能动');
    }
}

// ---------- 22. 播放模式：图标按钮 + 点一下切下一个 ----------
// 用户 2026/10/15：「改播放模式的最好改成图标显示，而且点一下切换下一个模式」。
// 原来是 <select> 下拉，和播放条其它图标格格不入。
// ⚠️ 图标路径是我手抄的 Material 路径 —— 抄错一个数字图标就画歪了，
//    而且我**看不到渲染结果**，所以这里额外做一次坐标 sanity check。
{
    const badBefore = bad;
    // ① 旧的下拉框必须没了，新的图标按钮必须在
    if (/<select id="mode"/.test(head)) fail('还留着 <select id="mode">，用户要求改成图标按钮');
    if (!/<button id="btn-mode"/.test(head)) fail('HTML 里找不到 #btn-mode');

    // ② 图标现在是 **Remix 的 sprite**（页面里 <symbol id="ri-xxx">，用 <use href> 引用），
    //    不再是手抄的 SVG path（2026/10/19 重写）。所以要检查：
    //    4 个模式各映射到一个 sprite 名，而且那个 symbol 真的在页面里 ——
    //    名字拼错会得到一个看不见图标的空白按钮，而且肉眼很难发现。
    // ⚠️ 现在它是一行写完的（`const MODE_ICON = { … };`），
    //    原来那个"必须换行+4空格再 `};`"的正则会抓不到（2026/10/19 踩过）。
    const iconBlock = js.match(/const MODE_ICON = \{[^}]*\};/);
    if (!iconBlock) {
        fail('找不到 MODE_ICON（播放模式的图标映射）');
    } else {
        const pairs = [...iconBlock[0].matchAll(/(?:'([\w-]+)'|([\w-]+))\s*:\s*'([\w-]+)'/g)]
            .map((m) => [m[1] || m[2], m[3]]);
        const modes = ['sequence', 'loop-all', 'loop-one', 'shuffle'];
        if (pairs.length !== 4) fail('MODE_ICON 应该正好 4 个模式，实际 ' + pairs.length);
        if (new Set(pairs.map((p) => p[1])).size !== pairs.length) fail('MODE_ICON 有重复的图标（两个模式长得一样）');
        for (const [mode, icon] of pairs) {
            if (!html.includes('<symbol id="ri-' + icon + '"')) fail('MODE_ICON 指向的图标在 sprite 里不存在: ' + mode + ' → ' + icon);
        }
        for (const m of modes) if (!iconBlock[0].includes(m)) fail('MODE_ICON 缺少模式 ' + m);
    }

    // ③ 播放键要更大更醒目（用户 2026/10/15 要求："整体黑，中间白，突出这个按钮"）。
    //    ⚠️ 2026/10/19 重写后它不再是"46px 黑圆"，而是**比旁边按钮大一号的图标键**
    //    （#player button 36px / #btn-toggle 42px；配色跟播放条走）。
    //    所以这里改盯"更大 + 有圆角 + 用 SVG 图标"，不再盯具体的黑底和 46px。
    const toggleCss = (css.match(/#btn-toggle \{[^}]*\}/) || [''])[0];
    const baseCss = (css.match(/#player button \{[^}]*\}/) || [''])[0];
    const px = (re, s) => Number((s.match(re) || [])[1] || 0);
    const toggleW = px(/width:\s*(\d+)px/, toggleCss);
    const baseW = px(/width:\s*(\d+)px/, baseCss);
    if (!toggleCss) fail('找不到 #btn-toggle 的样式');
    else if (!/border-radius/.test(toggleCss)) fail('#btn-toggle 没有圆角');
    else if (!toggleW) fail('#btn-toggle 没写宽度');
    else if (!(toggleW > baseW)) fail('#btn-toggle 没比旁边的按钮大（' + toggleW + 'px vs ' + baseW + 'px），播放键要更醒目');
    // 播放/暂停图标必须是 SVG —— ⏸ 那个字形又细又小，用户明确说太小
    if (!/function setPlayIcon\(/.test(js)) fail('缺少 setPlayIcon()');
    // ⚠️ 光查函数在不在不够 —— 只查存在时，把函数体换成 `btn.textContent = '⏸'` 照样通过（假绿）。
    //    要盯住"它真的画了 SVG，而且播放/暂停两个图标都覆盖到"。
    {
        const setPlay = (js.match(/function setPlayIcon\([\s\S]*?\n    \}/) || [''])[0];
        if (!setPlay) fail('找不到 setPlayIcon 的函数体');
        else if (!/setIconButton\(/.test(setPlay)) fail('setPlayIcon 没有画 SVG（又退回用 ⏸ 字符了）');
        else if (!/play-fill/.test(setPlay) || !/pause-fill/.test(setPlay)) {
            fail('setPlayIcon 没有同时覆盖 播放/暂停 两个图标');
        }
    }
    for (const ic of ['ri-play-fill', 'ri-pause-fill']) {
        if (!html.includes('<symbol id="' + ic + '"')) fail('sprite 里缺 ' + ic + '（播放/暂停图标会是空白）');
    }

    // ④ 真点 4 下，看是不是"顺序 → 列表循环 → 单曲循环 → 随机 → 顺序"
    const harness =
        js +
        `
    return { _el: (id) => document.getElementById(id), _order: MODE_ORDER };`;
    let api = null;
    try {
        // ⚠️ 这里的假服务端必须**有状态**：启动链的 refreshState() 会在后台跑，
        //    如果 /api/state 永远回 mode:'sequence'，它就会把刚切好的模式冲回去，
        //    测试里看起来像"点一下没切过去"（我为此查了一轮，其实是假服务端的锅）。
        //    真实服务端是记住模式的，所以假服务端也得记住。
        let serverMode = 'loop-all'; // 服务端默认就是列表循环（src/api.js 里那个 fresh 队列）
        api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            makeApiStub({
                // /api/queue/mode 要**回显并记住**请求里的 mode
                '/api/queue/mode': (opt) => {
                    serverMode = JSON.parse((opt && opt.body) || '{}').mode;
                    return { mode: serverMode, items: [], currentId: null };
                },
                '/api/state': () => ({ playlists: [], shared: [], queue: { items: [], currentId: null, mode: serverMode } }),
            }),
            { clipboard: undefined },
            fakeWindow,
            () => 0
        );
    } catch (e) {
        fail('掏模式按钮失败: ' + e.message);
    }
    if (api) {
        // 启动链（loadMe → refreshState）是异步的，等一拍让真实的模式落到按钮上
        await new Promise((r) => setTimeout(r, 0));
        const btn = api._el('btn-mode');
        // 2026/10/17：默认模式改成**列表循环**了（用户要求；原来是顺序播放 ✓）
        // ⚠️ 断言跟着用 DEFAULT_MODE 的**值**核对，别再钉死那个字符串 ✗
        const DEFAULT_MODE = 'loop-all';
        // 初始状态由启动链里的 renderMode(...) + refreshState 设好
        if (btn.dataset.mode !== DEFAULT_MODE) fail('模式按钮初始不是 ' + DEFAULT_MODE + ': ' + btn.dataset.mode);
        // 图标现在是 Remix sprite：<svg><use href="#ri-xxx"></use></svg>
        //（原来是手写 path 的 `d`，所以这里改成读 use 的 href）
        const iconOf = (b) => {
            const svg = (b.children || [])[0];
            if (!svg) return '';
            const kid = (svg.children || []).find((c) => c.tagName === 'use') || (svg.children || [])[0];
            return (kid && kid.attrs && (kid.attrs.href || kid.attrs['xlink:href'])) || '';
        };
        if (!iconOf(btn)) fail('模式按钮里没有画图标（<use href> 缺失）');
        if (!/列表循环/.test(btn.title || '')) fail('模式按钮的悬浮提示不对: ' + btn.title);
        // 点一圈：loop-all → loop-one → shuffle → sequence → loop-all（MODE_ORDER 的环）
        const seen = [btn.dataset.mode];
        const icons = [iconOf(btn)];
        for (let i = 0; i < 4; i++) {
            btn._fire('click');
            await new Promise((r) => setTimeout(r, 0));
            seen.push(btn.dataset.mode);
            icons.push(iconOf(btn));
        }
        const expect = ['loop-all', 'loop-one', 'shuffle', 'sequence', 'loop-all'];
        if (seen.join(' → ') !== expect.join(' → ')) {
            fail('点一下切下一个的顺序不对：' + seen.join(' → ') + '（期望 ' + expect.join(' → ') + '）');
        }
        if (new Set(icons).size !== 4) fail('切换模式时图标没跟着换（4 个模式画出来只有 ' + new Set(icons).size + ' 种）');
        if (bad === badBefore) console.log('OK    播放模式改成图标按钮，点一下按 顺序→列表循环→单曲循环→随机 循环切换');
    }
}

// ---------- 23. 歌名：悬停看全名 + 选中能复制全文 ----------
// 用户 2026/10/15：「鼠标悬停在省略的名字上应该能显示全名，并且这样全选名字的时候
// 应该能复制完整的名字，目的是为了方便进入 b 站搜索原本的视频进行收藏」，
// 随后明确：「不是要按钮，是直接全选歌名就能复制完整歌名（即使有省略）」。
//
// 关键认识（我一开始也差点搞错方向）：
//   text-overflow: ellipsis **只是视觉**，DOM 里一直是完整标题 ——
//   所以"选中复制"本来就能拿到全文，不需要什么按钮，也不需要 HTTPS。
//   真正缺的只有 title 属性：原来行的 title 被"双击播放"占了，悬停看不到歌名。
// 这里要盯住的就是：① DOM 文本 = 全文 ② title 属性 = 全文 ③ 没有加多余按钮
{
    const badBefore = bad;
    const harness =
        js +
        `
    return { buildRow, _el: (id) => document.getElementById(id) };`;
    let api = null;
    try {
        api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            makeApiStub(),
            { clipboard: undefined },
            fakeWindow,
            () => 0
        );
    } catch (e) {
        fail('掏 buildRow 失败: ' + e.message);
    }
    if (api) {
        // 一个"长到一定会被省略号截断"的名字（顺便验 B 站那种超长标题）
        const full = '【初音ミク】一首名字特别特别长的歌 / コラコーラ feat. 花隈千冬【本家投稿】';
        const li = api.buildRow({ index: 1, cover: '', title: full, duration: 100, buttons: [], dataset: { bvid: 'BV1Aupg64ECJ' } });
        const tDiv = (li.children || []).find((c) => c.className === 't');
        const bEl = tDiv && (tDiv.children || [])[0];
        if (!bEl) fail('行里找不到歌名元素');
        else {
            // ① DOM 文本必须是全文 —— 否则选中复制真的只剩一半
            if (bEl.textContent !== full) fail('歌名在 DOM 里被截断了（选中复制会只剩一半）: ' + bEl.textContent);
            // ② 被截断时要能**摊开**显示全名。
            //    ⚠️ 用户实测：只挂原生 title 不行 —— 拖选仍被 overflow:hidden 限制在可见那一段，
            //       所以复制到的是截断文本。必须真的把全文渲染出来（加 .full 类 → 绝对定位块）。
            //    ⚠️⚠️ 而且**只有真被截断才摊开**：中间列表的行本来就显示得下，
            //       悬停还弹一层浮层会把原位置挡住、想复制反而别扭（用户反馈）。
            const fullRule = (css.match(/li\.row \.t b\.full[^{]*\{[^}]*\}/) || [''])[0];
            // ⚠️ CSS 现在是压过的写法（`position:absolute` 没有空格），所以断言里一律用 \s*
            if (!/position:\s*absolute/.test(fullRule)) fail('歌名被截断时没有摊开（看不到全名）');
            if (!/white-space:\s*normal/.test(fullRule)) fail('歌名摊开后没换行（还是单行，全文摊不开）');
            if (!/overflow:\s*visible/.test(fullRule)) fail('歌名摊开后没解除裁剪');
            if (!/#np-title\.full/.test(css)) fail('播放条上的歌名没有同样的摊开规则');
            // 摊开的开关必须是"真被截断"判断出来的，不能挂 :hover（否则整行都会弹浮层）
            if (/li\.row \.t b:hover/.test(css) || /#np-title:hover/.test(css)) {
                fail('摊开挂成了 :hover —— 没被截断的行也会弹浮层（用户说这样复制很别扭）');
            }
            {
                const mo = (js.match(/document\.addEventListener\('mouseover'[\s\S]*?\n    \}\);/) || [''])[0];
                if (!mo) fail('没有 mouseover 监听（没人给歌名加 .full）');
                else {
                    if (!/scrollWidth > el\.clientWidth/.test(mo)) {
                        fail('mouseover 里没判断"是否真被截断"（scrollWidth > clientWidth）');
                    }
                    if (!/classList\.add\('full'\)/.test(mo)) fail('mouseover 里没有加 .full');
                }
                if (!/document\.addEventListener\('mouseout'/.test(js)) fail('没有 mouseout 监听（摊开后收不回去）');
            }
            // ③ 行的 title 仍然是"双击播放"那类操作提示，别被歌名顶掉
            if (li.title === full) fail('歌名把行的操作提示顶掉了（li.title 应该是"双击…"）');
            // ④ 不要按钮：用户明确说"不是要按钮"
            if (/\$\('btn-copy-title'\)/.test(js) || /id="btn-copy-title"/.test(head)) {
                fail('又加回【复制歌名】按钮了 —— 用户要的是直接选中复制，不要按钮');
            }
            // ⑤ 必须 user-select: all —— 点一下就是**整段全选**，
            //    这样 Ctrl+C 拿到的是完整标题（拖选会被 overflow:hidden 限制在可见那段）
            if (!/li\.row \.t b[^{]*\{[^}]*user-select:\s*all/.test(css)) {
                fail('歌名不是 user-select: all（点一下选不全，复制会只剩可见那段）');
            }
        }
    }

    // ⑤ HTTP 下的兜底：不安全上下文时不能走 navigator.clipboard（浏览器禁用），
    //    得回退到 textarea + execCommand —— 【分享】和邀请码复制都靠它
    {
        const harness2 =
            js +
            `
    return { copyText };`;
        let usedClipboard = false;
        let api2 = null;
        try {
            api2 = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness2)(
                makeFakeDocument(),
                { getItem: () => null, setItem() {}, removeItem() {} },
                makeApiStub(),
                {
                    clipboard: {
                        writeText: () => {
                            usedClipboard = true;
                            return Promise.resolve();
                        },
                    },
                },
                { ...fakeWindow, isSecureContext: false }, // ← HTTP 部署的样子
                () => 0
            );
        } catch (e) {
            fail('掏 copyText 失败: ' + e.message);
        }
        if (api2) {
            const ok = await api2.copyText('测试歌名');
            if (usedClipboard) fail('HTTP（不安全上下文）下不该走 navigator.clipboard —— 浏览器会直接拒绝');
            if (!ok) fail('HTTP 下 copyText 应该用 execCommand 兜底并返回成功');
            if ((await api2.copyText('')) !== false) fail('空字符串不该算复制成功');
        }
    }
    if (bad === badBefore) console.log('OK    歌名：悬停摊开显示全名（全文真实渲染，能全选复制），且没加多余按钮');
}

// ---------- 24. 播放条右侧那组控件的位置 ----------
// 用户 2026/10/15：「右下角这些 ui 整体往左调，大概调到这个位置」（圈了模式/静音/音量/播放列表）。
// 当时的做法是给 #np-right 加 padding-right。
// ⚠️ 2026/10/19 重写后播放条改用 grid（左/中/右三列），靠 `justify-content:flex-end`
//    贴右边、再用 `#volume-control` 的 margin-right 留白 —— 效果一样，机制变了，
//    所以断言改成盯这两条（别再按 padding-right 判红）。
{
    const badBefore = bad;
    const rule = (css.match(/#np-right \{[^}]*\}/) || [''])[0];
    const vol = (css.match(/#volume-control \{[^}]*\}/) || [''])[0];
    if (!rule) fail('找不到 #np-right 的样式');
    else if (!/justify-content:\s*flex-end/.test(rule)) fail('#np-right 没有靠右对齐（那组控件会跑到中间）');
    else if (!/margin-right:\s*\d+px/.test(vol)) fail('#volume-control 没有右边距（这组控件会贴死播放条右边缘）');
    if (bad === badBefore) console.log('OK    播放条右侧那组控件靠右、且留了右边距（#np-right + #volume-control）');
}

// ---------- 25. 取流地址过期要能自愈 ----------
// 用户 2026/10/15 报过一个错：点播放弹出「播放失败: The element has no supported sources.」
// 原因：服务端缓存取流地址 90 分钟，但 B 站那个签名地址本身约 120 分钟就失效；
// 客户端 <audio> 里的 src 还可能留得更久（标签页开着不动）。
// 更糟的是**再点播放也没用** —— src 没变，还是那个死地址。
// 所以必须：① 加载失败自动重取一次（fresh=1 绕开服务端缓存）② 别死循环
{
    const badBefore = bad;
    if (!/function refetchAudio\(/.test(js)) fail('缺少 refetchAudio()（地址过期时没救）');
    if (!/el\.dataset\.bvid = bvid/.test(js)) fail('playMedia 没记住 bvid —— 加载失败时不知道重取哪首');
    const errHandler = (js.match(/\$\('a'\)\.addEventListener\('error'[\s\S]*?\n    \}\);/) || [''])[0];
    if (!errHandler) fail('没有监听音频的 error 事件（加载失败不会自愈）');
    else {
        if (!/refetchAudio\(\)/.test(errHandler)) fail('error 事件里没有重新取流');
        if (!/freshTried/.test(errHandler)) fail('error 事件里没有"只重试一次"的保护（可能死循环刷请求）');
    }
    if (!/fresh=1/.test(js)) fail('重取时没带 fresh=1（拿回来的还是缓存里那个死地址）');
    // 播放键：src 有但加载失败（a.error）时也要重取，不能拿着死地址再 play。
    // ⚠️ 要精确匹配**外层那个判断** —— 我第一版只查 handler 里有没有出现 `a.error`，
    //    而内层还有一处，所以把外层条件去掉也照样通过（假绿）
    const toggle = (js.match(/\$\('btn-toggle'\)\.addEventListener\('click'[\s\S]*?\n    \}\);/) || [''])[0];
    if (!toggle) fail('找不到播放键的处理函数');
    else if (!/if \(!a\.getAttribute\('src'\) \|\| a\.error\)/.test(toggle)) {
        fail('播放键外层判断没带 a.error（src 已失效时再点也没用）');
    }
    if (bad === badBefore) console.log('OK    取流地址过期能自愈（error 自动重取一次 + 播放键也会重取）');
}

// ---------- 26. 前端的「歌单上限」必须和后端一致 ----------
// 导入收藏夹时分不分片，前端是按自己的 PLAYLIST_MAX 判断的；
// 后端 api.js / index.js 也用它校验和截断。两边不一致就会出现
// 「前端说分成 5 个、后端只建了 4 个」这种莫名其妙的怪事。
// 所以直接从 src/track.js 读真值来比 —— 这是唯一能跨文件对齐的办法。
{
    const badBefore = bad;
    const m = js.match(/const PLAYLIST_MAX = (\d+)/);
    if (!m) {
        fail('前端找不到 PLAYLIST_MAX（导入收藏夹分片的判断要用）');
    } else {
        let backend = null;
        try {
            backend = (fs.readFileSync(new URL('../src/track.js', import.meta.url), 'utf8').match(/export const PLAYLIST_MAX = (\d+)/) || [])[1];
        } catch {
            /* 读不到就不比 */
        }
        if (backend && backend !== m[1]) {
            fail('前端的 PLAYLIST_MAX(' + m[1] + ') 和 src/track.js(' + backend + ') 对不上');
        }
        if (bad === badBefore) console.log('OK    前端 / 后端的「歌单上限」常量一致（都是 ' + m[1] + '）');
    }
}

// ---------- 27. 播放条左侧的歌名/up主名必须**稳定** ----------
// 用户 2026/10/15 反馈："最小[号]会莫名其妙显示三种样子的歌曲信息，
// 只有最后那个样子是需要的" —— 指的是播放条左侧那一块：
//   ① 只有歌名（up 主名空着）② 歌名 + up 主名 + 一行"一起听 · SYNZI" ③ 歌名 + up 主名 ✓
// 三种的来源：房间路径没用 /api/audio 带回来的 author；本地 state 没回写 author
// 导致后续 setNowPlaying 把它清掉；房间提示把 up 主名又念了一遍还占了播放条那行。
{
    const badBefore = bad;

    // ① 房间播放路径：track.author 为空时要退回用 info.author
    if (!/setNowPlaying\(track\.title, track\.cover, track\.author \|\| info\.author\)/.test(js)) {
        fail('房间播放路径没退回用 info.author（up 主名会时有时无）');
    }
    // ② playMedia 要把学到的 author 写回本地条目，否则下一次 setNowPlaying 会清掉它
    {
        const pm = (js.match(/async function playMedia\([\s\S]*?\n    \}/) || [''])[0];
        if (!pm) fail('找不到 playMedia');
        else if (!/it\.author = a\.author/.test(pm)) {
            fail('playMedia 没把学到的 up 主名写回本地条目（up 主名会被后续 setNowPlaying 清掉）');
        }
    }
    // ③ 房间切歌的提示：别重复 up 主名，也别占播放条那行
    if (/hint\('一起听 · ' \+ \(info\.author/.test(js)) {
        fail('房间提示又把 up 主名念了一遍（播放条会多出一行没用的）');
    }
    if (!/hint\('一起听 · 已切到这首', \{ bar: false \}\)/.test(js)) {
        fail('房间切歌的提示要只弹浮层（bar:false）—— 否则播放条那行会被高频刷');
    }
    if (!/function hint\(text, \{ bar = true \} = \{\}\)/.test(js)) {
        fail('hint() 没有 bar 选项（没法只弹浮层不占播放条）');
    }
    if (bad === badBefore) console.log('OK    播放条左侧稳定：歌名 + up 主名（房间提示不再插一行）');
}

// ---------- 28. 点【搜索】按钮不能拿"事件对象"当搜索词 ----------
// 用户 2026/10/15：搜了一长串标题，结果全是标题里含 "object" 的视频，
// 问「是不是搜索有输入上限，完全在乱搜」。
// 根因：doSearch 既被当**事件处理器**用（btn / go 的 click），又读了第一个参数 ——
//       String(MouseEvent) === "[object MouseEvent]"，拿这个去搜，
//       B 站自然只能匹配到 "object"。**按回车是好的，只有点按钮中招**。
//
// 这条**必须行为验证**：静态查代码形状很容易漏（换个写法就绕过去了）。
// 这里就真点一下按钮，看发出去的请求里 q= 到底是什么。
{
    const badBefore = bad;
    const harness = js + '\n    return { _el: (id) => document.getElementById(id) };';
    const urls = [];
    let api = null;
    try {
        // ⚠️ 必须复用 makeApiStub()：自己临时写一个只会回 {items:[]} 的 stub，
        //    会把启动链里的 /api/state 也弄坏 → state.playlists undefined → 整节崩掉
        //    （这个坑我今天已经踩过一次了）
        const inner = makeApiStub();
        api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            async (u, opt) => {
                urls.push(String(u));
                return inner(u, opt);
            },
            {},
            fakeWindow,
            () => 0
        );
    } catch (e) {
        fail('第 28 节跑脚本失败: ' + e.message);
    }
    if (api) {
        const q = '【本家投稿】Second Roll / LoA feat.v_flower';
        const sentOf = (hit) => decodeURIComponent(((hit || '').match(/[?&]q=([^&]*)/) || [])[1] || '');
        // ① 点【搜索】按钮 —— 真浏览器这里传进来的是 MouseEvent
        api._el('q').value = q;
        api._el('btn')._fire('click', { type: 'click', target: api._el('q') });
        await new Promise((r) => setTimeout(r, 0));
        const hit = urls.find((u) => u.includes('/api/search'));
        if (!hit) fail('点了【搜索】没发出 /api/search 请求');
        else {
            const sent = sentOf(hit);
            if (/\[object/i.test(sent)) fail('点【搜索】按钮把事件对象当搜索词了: ' + sent);
            else if (sent !== q) fail('点【搜索】发出去的关键词不对: ' + JSON.stringify(sent));
        }
        // ② 回车也要对（这条本来就对，别被改坏）
        urls.length = 0;
        api._el('q')._fire('keydown', { key: 'Enter' });
        await new Promise((r) => setTimeout(r, 0));
        const sent2 = sentOf(urls.find((u) => u.includes('/api/search')));
        if (sent2 !== q) fail('按回车发出的关键词不对: ' + JSON.stringify(sent2));
        if (bad === badBefore) console.log('OK    点【搜索】按钮 / 按回车 发出去的都是输入框原文（不是 [object MouseEvent]）');
    }
}

// ---------- 29. 离线宽限期：成员列表要标出"离线中" ----------
// 用户 2026/10/15：「设置离线后 60 秒没上线再自动退出」。
// 服务端现在会在这 60 秒里把人留在成员表里、并带上 offline: true
//（见 scripts/check-offline-grace.mjs）。前端必须把它显示出来 ——
// 不然别人以为他还在听，房主位子也看着像有人占着。
{
    const badBefore = bad;
    const rm = (js.match(/function renderMembers\([\s\S]*?\n    \}/) || [''])[0];
    if (!rm) fail('找不到 renderMembers()');
    else if (!/m\.offline/.test(rm)) fail('成员列表没处理 offline 标记（断线的人看起来还在听）');
    // ⚠️ 要具体到"压暗"这条 —— 光查 `#member-list li.offline` 存在没用，
    //    旁边还有一条挂小标的规则也叫这个名字，删掉压暗那条照样通过（假绿）
    if (!/#member-list li\.offline \{[^}]*opacity/.test(css)) {
        fail('CSS 里 #member-list li.offline 没有压暗（opacity）');
    }
    if (bad === badBefore) console.log('OK    成员列表会标出"离线中"的人（宽限期内压暗 + 挂小标）');
}

// ---------- 30. 房间没了要**停下来**，别无限重连 ----------
// 2026/10/15 用户报「我怎么房间自动关闭了」：
// 他手动更新时 systemctl restart 过（重启清空所有房间是设计如此），
// 但前端拿到 404 之后**一直重连** —— 线上日志被刷成每 3 秒一条
// 「[ERR] 房间不存在」，界面还挂着一个已经不在的房间。
{
    const badBefore = bad;
    const stream = (js.match(/async function openRoomStream\([\s\S]*?\n    \}/) || [''])[0];
    if (!stream) fail('找不到 openRoomStream()');
    else {
        if (!/r\.status === 404/.test(stream)) {
            fail('openRoomStream 没处理 404（房间不存在时会无限重连刷服务器）');
        }
        if (!/leaveRoomLocally\(/.test(stream)) {
            fail('房间不存在时没有本地退出（界面会一直挂着死房间）');
        }
        // 重连只在"不是房间没了"的情况下发生
        if (!/if \(gone\) \{[\s\S]*?return;/.test(stream)) {
            fail('openRoomStream 没有"房间没了就别重连"的分支');
        }
    }
    if (!/function leaveRoomLocally\(/.test(js)) fail('缺少 leaveRoomLocally()（退出房间的收尾逻辑要共用一份）');
    // 「管理员删房」和「房间已不存在」必须走同一套收尾，别写两遍
    if (!/if \(event === 'deleted'\) \{\s*leaveRoomLocally\(/.test(js)) {
        fail('deleted 事件没走 leaveRoomLocally（收尾逻辑被抄成两份了）');
    }
    if (bad === badBefore) console.log('OK    房间不存在时本地退出并停止重连（不再 404 刷服务器）');
}

// ---------- 31. 歌单行的按钮：要【下一首】，不要 ↑↓ ----------
// 用户 2026/10/15：「歌单列表没有加入下一首，并且我觉得那个上下调节是不需要的」。
// 歌单的排列以 B 站收藏夹为准，手动挪没什么意义；缺的其实是"插到下一首"。
// 注意别把**队列**里的 ↑↓ 一起删了 —— 那是播放顺序，用户之前专门要的。
{
    const badBefore = bad;
    const mk = (js.match(/function makeTrackRow\([\s\S]*?\n    \}/) || [''])[0];
    if (!mk) fail('找不到 makeTrackRow()');
    else {
        // ⚠️ 要精确匹配**歌单那一支**的那行 —— 我用 `editable.*\['next'` 这种宽松正则时，
        //    把歌单行的 next 删掉它照样通过（假绿）
        // ⚠️ 两种歌单都要有 —— "不是自己的歌单"那一支以前没有【下一首】，
        //    于是朋友在房间里点开你的歌单**根本没入口**（后端其实是放行的）。
        //    用"这行出现了几次"来判断，比去正则里抠分支结构稳得多
        //（我第一版就是去匹配 `: [ ... ];` 结构，写崩了还报"找不到"）
        {
            const n = (mk.match(/\['next', '下一首', '插到当前播放的后面（不打断）'\]/g) || []).length;
            if (n < 2) fail('【下一首】只给了一种歌单（自己的和别人打开时都要有），实际 ' + n + ' 处');
        }
        // 而且不能再有 up / down
        if (/editable[\s\S]{0,800}?\['up'/.test(mk)) fail('歌单行还有 ↑ 调顺序（用户说不需要）');
        if (/editable[\s\S]{0,800}?\['down'/.test(mk)) fail('歌单行还有 ↓ 调顺序（用户说不需要）');
    }
    // 队列（自己的队列 / 房间队列）里的 ↑↓ 要留着
    if (!/\['up', '↑', '上移'\]/.test(js)) fail('队列里的 ↑ 按钮被误删了（那是排序，不是歌单）');
    if (bad === badBefore) console.log('OK    歌单行有【下一首】、没有 ↑↓；队列里的 ↑↓ 保留');
}

// ---------- 32. 没身份要自动补，别把开发者话术甩给用户 ----------
// 用户 2026/10/16 手机上截图报：
//   「进房间失败：需要身份：先 POST /api/auth/guest 拿游客令牌，或登录」
// 根因：前端只有**启动链**里那一枪领游客令牌，打空了（或者页面还没跑完就被点了）
// 后面所有操作全废，而且报错是服务端的开发者话术。
// 现在把这件事收在 jfetch（所有请求唯一的出口）里：
//   ① 没令牌就先领一个  ② 身份丢了就重领一个再试一次（只一次）
// 这条**必须行为验证** —— 静态查代码很容易看不出"到底有没有先领身份"。
{
    const badBefore = bad;
    const harness = js + `\n    return { _clearToken: () => setToken(''), _join: (id) => joinRoom(id), _token: () => token };`;
    const calls = [];
    const ROOM = {
        roomId: 'rTEST', name: '测试房', hostId: 's:1', isPrivate: false,
        controllerIds: [], createdAt: Date.now(), trackId: null, track: null,
        isPlaying: false, anchorPosition: 0, anchorServerTime: 0, position: 0,
        startsIn: 0, serverTime: Date.now(), mode: 'sequence',
        queue: { items: [], currentId: null, mode: 'sequence' },
        members: [], you: { key: 's:1', name: '我', isHost: true, canControl: true },
    };
    let joinHits = 0;
    let guestOk = true;
    let staleFirst = false;
    let api = null;
    try {
        const inner = makeApiStub({
            '/api/auth/guest': () => {
                calls.push('guest');
                if (!guestOk) throw new Error('（假服务端：拿不到游客身份）');
                return { token: 'guest-' + calls.length };
            },
            '/api/rooms/rTEST/join': () => {
                joinHits++;
                calls.push('join' + joinHits);
                // 第一次假装"你的身份没了"
                if (staleFirst && joinHits === 1) throw Object.assign(new Error('需要身份'), { _status: 401 });
                return ROOM;
            },
        });
        // makeApiStub 是靠"URL 里包含 key"匹配的，抛错要靠 override 里自己抛；
        // 这里再包一层，把"需要身份"变成真的 401 响应
        const wrapped = async (u, opt) => {
            if (String(u).indexOf('/api/rooms/rTEST/join') === 0 && staleFirst && joinHits === 0) {
                joinHits++;
                calls.push('join1');
                return { ok: false, status: 401, json: async () => ({ error: '需要身份' }) };
            }
            return inner(u, opt);
        };
        api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            wrapped,
            {},
            fakeWindow,
            () => 0
        );

        // ① 把令牌清掉（模拟"启动链那一枪打空了"），加入房间应该自己先领身份
        api._clearToken();
        calls.length = 0;
        await api._join('rTEST');
        if (calls.indexOf('guest') < 0) fail('① 没令牌时加入房间没有先领游客身份: ' + JSON.stringify(calls));
        else if (calls.indexOf('guest') > calls.findIndex((c) => c.indexOf('join') === 0)) {
            fail('① 领身份发生在加入房间之后（顺序反了）: ' + JSON.stringify(calls));
        }

        // ② 令牌在但服务端说"需要身份" → 重领一个并**重试**
        api._clearToken();
        calls.length = 0;
        joinHits = 0;
        staleFirst = true;
        await api._join('rTEST');
        if (calls.filter((c) => c === 'guest').length < 1) fail('② 身份失效时没有重新领身份: ' + JSON.stringify(calls));
        else if (joinHits < 2) fail('② 身份失效后没有重试加入房间（直接把错误甩给用户了）: ' + JSON.stringify({ joinHits, calls }));
        // ③ 启动链里 /api/auth/me 失败时**不能清令牌**
        //    （网络抖一下 ≠ 会话不存在；清了的话后面所有操作都没身份，
        //     报的正是朋友看到的那句"需要身份：先 POST /api/auth/guest…"）
        {
            const lm = (js.match(/async function loadMe\([\s\S]*?\n    \}/) || [''])[0];
            if (!lm) fail('找不到 loadMe()');
            else {
                // ⚠️ 先把 // 注释去掉再查 —— 我在那段注释里引用了 `setToken('')`，
                //    不去掉的话断言会命中注释、把真文件判红（今天第 7 次踩这个坑了）
                const tail = lm.slice(lm.lastIndexOf('catch')).replace(/\/\/[^\n]*/g, '');
                if (/setToken\(''\)/.test(tail)) {
                    fail('loadMe 的 catch 里清了令牌（网络抖一下就把身份弄没了）');
                }
                if (!/renderAuth\(\)/.test(lm)) fail('loadMe 结尾没有 renderAuth()');
            }
        }
    } catch (e) {
        fail('第 32 节跑脚本失败: ' + e.message);
    }
    if (bad === badBefore) console.log('OK    没身份会自动补、身份失效会自动重领并重试（网络抖动不会清掉身份）');
}

// ---------- 33. 打开队列面板要定位到"正在播的那首" ----------
// 用户 2026/10/16：队列 996 首，打开面板从头开始翻，根本找不到现在放到哪了。
// 期望：① 打开时把正在播的那首放到中间（center）
//       ② 换歌时只在它看不见时才挪（nearest），别打断正在翻列表的人
//       ③ 没换歌就别乱滚
{
    const badBefore = bad;
    const harness =
        js +
        `\n    return {
        _el: (id) => document.getElementById(id),
        _setQueue: (q) => { state.queue = q; },
        _renderQueue: () => renderQueue(),
        _openPanel: () => openPlPanel(),
        _closePanel: () => closePlPanel(),
    };`;
    globalThis.__scrolls = [];
    let api = null;
    const items = [
        { id: 'a', bvid: 'BV1', title: '第一首', duration: 100 },
        { id: 'b', bvid: 'BV2', title: '第二首', duration: 100 },
        { id: 'c', bvid: 'BV3', title: '第三首', duration: 100 },
    ];
    // ⚠️ 假服务端必须**有状态**：启动链的 refreshState() 会在后台跑，
    //    /api/state 要是永远回空队列，它就会把我注入的队列冲掉 ——
    //    症状是"渲染出来 0 行"（第 22 节踩过一模一样的坑）
    let liveQueue = { items, currentId: 'a', mode: 'sequence' };
    try {
        // ⚠️ 这里必须传**真的** setTimeout：打开面板那次滚动是刻意延到下一帧的
        //    （面板 show 出来之前滚会滚不准），别的节传的是"假的 setTimeout"（永不触发）
        api = new Function('document', 'localStorage', 'fetch', 'navigator', 'window', 'setTimeout', harness)(
            makeFakeDocument(),
            { getItem: () => null, setItem() {}, removeItem() {} },
            makeApiStub({ '/api/state': () => ({ playlists: [], shared: [], queue: liveQueue }) }),
            {},
            fakeWindow,
            setTimeout
        );
    } catch (e) {
        fail('第 33 节跑脚本失败: ' + e.message);
    }
    if (api) {
        api._setQueue(liveQueue);
        globalThis.__scrolls = [];
        api._renderQueue();
        const n1 = globalThis.__scrolls.length;
        if (n1 !== 1) fail('第一次渲染队列应该把"正在播的"滚进视野一次，实际 ' + n1 + ' 次');
        else if (globalThis.__scrolls[0] !== 'nearest') fail('渲染时应该用 nearest（不打断翻列表的人），实际 ' + globalThis.__scrolls[0]);

        // 没换歌：再渲染一次不该滚
        globalThis.__scrolls = [];
        api._renderQueue();
        if (globalThis.__scrolls.length !== 0) fail('没换歌却又滚了 ' + globalThis.__scrolls.length + ' 次（会打断正在翻列表的人）');

        // 换歌：应该滚
        globalThis.__scrolls = [];
        liveQueue = { items, currentId: 'c', mode: 'sequence' };
        api._setQueue(liveQueue);
        api._renderQueue();
        if (globalThis.__scrolls.length !== 1) fail('换歌后应该把它带进视野一次，实际 ' + globalThis.__scrolls.length + ' 次');

        // 打开面板：应该居中定位
        globalThis.__scrolls = [];
        try {
            api._openPanel();
        } catch (e) {
            fail('第 33 节 _openPanel() 抛错: ' + e.message);
        }
        await new Promise((r) => setTimeout(r, 20)); // 面板是 setTimeout 0 之后才滚的
        if (globalThis.__scrolls.length !== 1) fail('打开面板应该定位一次，实际 ' + globalThis.__scrolls.length + ' 次');
        else if (globalThis.__scrolls[0] !== 'center') fail('打开面板应该用 center（放中间一眼看到），实际 ' + globalThis.__scrolls[0]);
        api._closePanel();
    }
    if (bad === badBefore) console.log('OK    打开队列面板会定位到正在播的那首（换歌才滚，不打断翻列表）');
}

// ---------- 34. 管理员随时能改房主 ----------
// 用户 2026/10/16："改成管理员可以随时改房主得了" ——
// 房主因为刷新/离开被系统交接给别人时，站长要能一句话改回来。
// 后端权限已在 scripts/check-room-perms.mjs 里行为验证过，这里只管前端入口。
{
    const badBefore = bad;
    // ⚠️ 先剥掉 // 注释再查：注释里引用了同样的字眼（'设为房主' / isAdmin()），
    //    不剥的话把代码删掉也照样通过（假绿，今天栽过好几次）
    const strip = (s) => String(s || '').replace(/\/\/[^\n]*/g, '');
    const rm = strip((js.match(/function renderMembers\([\s\S]*?\n    \}/) || [''])[0]);
    if (!rm) fail('找不到 renderMembers()');
    else {
        if (!/isAdmin\(\)/.test(rm)) fail('成员列表没给管理员改房主的入口（只有房主能看到按钮）');
        if (!/设为房主/.test(rm)) fail('管理员那个按钮的文案不对');
    }
    const tf = strip((js.match(/async function transferHost\([\s\S]*?\n    \}/) || [''])[0]);
    if (!tf) fail('找不到 transferHost()');
    else if (!/iAmHost\s*\?/.test(tf)) fail('改房主的确认文案没区分"我是房主"和"我是管理员"');
    if (bad === badBefore) console.log('OK    管理员随时能改房主（成员列表里对非房主的人有【设为房主】）');
}

// ---------- 35. 窄屏适配（iPad 竖屏 / 手机）----------
// 用户 2026/10/16 问「能做到适配移动端么，iPad 应该可以」。
// 改之前用无头浏览器按真实尺寸截图看过：1024×768 还行，
// **768×1024 歌名被挤成竖排的一两个字**，390 宽时列表只剩一条缝。
// 根因全是固定宽度（左栏 248、行内按钮 230、播放条 250+320、表头 .h-acts 230）。
// ⚠️ 2026/10/19 重写后断点变成 1100 / 800 / 560，左栏改成"可折叠 + 窄屏抽屉"，
//    CSS 容器查询 @container 也进来了 —— 这一节的断言跟着改成现在的机制，
//    但**守的东西没变**：抽屉能开、行和表头一起收、手机上按钮点得到、不许横向溢出。
{
    const badBefore = bad;
    const has = (re) => re.test(css);

    // 三个断点都要在
    for (const w of [1100, 800, 560]) {
        if (!has(new RegExp('@media\\(max-width: ?' + w + 'px\\)'))) fail('缺少 @media(max-width:' + w + 'px) 断点');
    }
    // ⚠️ 适配块必须在**文件末尾**（同优先级靠后生效）
    {
        const last = css.lastIndexOf('@media(max-width:560px)');
        const mainRule = css.indexOf('.main {');
        if (last < 0 || mainRule < 0 || last < mainRule) {
            fail('适配用的 @media 块不在基础规则之后（会被固定宽度覆盖）');
        }
    }
    // 左栏变抽屉（窄屏）
    if (!/#side \{ position:fixed/.test(css)) fail('窄屏没把 #side 变成抽屉（position: fixed 缺失）');
    if (!/#side\.open/.test(css)) fail('抽屉没有 .open 状态');
    if (!has(/#btn-side/)) fail('缺少 #btn-side（抽屉开关）的样式');
    if (!/<button id="btn-side"/.test(html)) fail('HTML 里没有 #btn-side 按钮');
    if (!/\$\('btn-side'\)\.addEventListener\('click'/.test(js)) fail('#btn-side 没有绑定点击');
    if (!/function toggleSide\(/.test(js)) fail('缺少 toggleSide()');
    if (!/<div id="scrim"><\/div>/.test(html)) fail('HTML 里没有 #scrim 遮罩');
    if (!/#scrim\.show/.test(css)) fail('#scrim 没有 .show 状态（点遮罩关不掉抽屉）');
    // 行内按钮和表头要一起收（只收行不收表头 = 表头错位，手机上截图里就是）
    if (!/\.h-acts,li\.row \.acts \{ width:\d+px/.test(css)) {
        fail('窄屏没把「行内按钮 + 表头 .h-acts」一起收窄（表头会和行错位）');
    }
    if (!/\.h-idx,li\.row \.idx \{ display:none/.test(css)) fail('窄屏没隐藏序号列（和行对不上）');
    // 触屏上没 hover：行内按钮必须常显（触屏设备媒体查询 hover:none）
    if (!/@media\(hover:none\)[\s\S]{0,200}?li\.row \.acts \{ opacity:1/.test(css)) {
        fail('触屏（hover:none）下行内按钮不会显示 —— 平板/手机上就用不了加入队列了');
    }
    // 手机上操作按钮改成"点中这行才浮出"（绝对定位）
    if (!/li\.row \.acts \{ position:absolute/.test(css)) fail('手机上操作按钮没改成浮出式（position:absolute 缺失）');
    // 防横向溢出：flex 里的 input 用 width:0 + flex:1（原来是 min-width:0）
    if (!/#bar input \{[^}]*width:\s*0/.test(css)) {
        fail('#bar input 缺 width:0 —— input 默认宽度会把整个文档撑宽（横向溢出）');
    }
    // 手机上播放条要显式排成两行（不能靠中间列 auto 撑宽）
    if (!/#player \{ grid-template-columns:1fr auto; grid-template-rows:auto auto/.test(css)) {
        fail('手机断点里播放条没显式排成两行（会撑出横向溢出）');
    }
    if (!/#np-ctrl \{ grid-column:1 \/ -1; grid-row:2/.test(css)) fail('#np-ctrl 没跨到第二行整行（手机播放条会挤成一团）');
    if (bad === badBefore) console.log('OK    窄屏适配在（1100/800/560 断点 + 抽屉 + 行与表头同步收窄 + 防溢出）');
}

// ---------- 36. 系统媒体控制（锁屏 / Windows 媒体弹窗）----------
// 用户 2026/10/16：「能做到类似 B 站那种画中画么？悬浮窗只要标题、up 主、
// 上一首、播放暂停、下一首、进度条」—— 他给的截图其实是**系统媒体控制**
// （navigator.mediaSession），不是 DOM 画中画。
// 实测：mediaSession 在 HTTP 下就有 ✓；documentPictureInPicture 要 HTTPS ✗。
{
    const badBefore = bad;
    if (!/navigator\.mediaSession\.metadata = new MediaMetadata/.test(js)) {
        fail('没设置 mediaSession.metadata（锁屏上看不到歌名/up 主/封面）');
    }
    // artist 必须是 up 主（用户点名要的那一行）
    if (!/artist: author/.test(js)) fail('mediaSession 的 artist 不是 up 主');
    // 四个基本动作都要接上
    for (const a of ['play', 'pause', 'previoustrack', 'nexttrack']) {
        if (!new RegExp("set\\('" + a + "'").test(js)) fail('mediaSession 没接 ' + a + '（系统上那个按钮会没反应）');
    }
    // 进度条靠 setPositionState；不喂就一直停在 0。
    // ⚠️ 要查**调用**，不是查函数定义里有没有 —— 我第一次只查 `setPositionState(`，
    //    把 timeupdate 里那行调用删掉照样通过（假绿）
    if (!/setPositionState\(/.test(js)) fail('没喂 setPositionState（系统那个进度条不会动）');
    // ⚠️ 页面里现在有**不止一个** timeupdate 监听（一个只画进度条，一个喂系统媒体控制）。
    //    原来用"第一个 timeupdate … 到下一个 `});`"去截，截到的是那个只画进度条的，
    //    于是误判"没喂 setPositionState"（2026/10/19 假红）。所以要把**每一个**都看一遍。
    {
        const blocks = [...js.matchAll(/\$\('a'\)\.addEventListener\('timeupdate'[\s\S]*?\n    \}\);/g)].map((m) => m[0]);
        if (!blocks.length) fail('找不到 timeupdate 处理');
        else if (!blocks.some((b) => /updateMediaPosition\(/.test(b))) {
            fail('timeupdate 里没调用 updateMediaPosition()（系统进度条不会动）');
        }
    }
    // 房间里切歌必须走 advance()，不能直接 play，否则绕过房主权限
    if (!/set\('nexttrack', \(\) => advance\('next'\)/.test(js)) {
        fail('mediaSession 的下一首没走 advance()（房间里会绕过房主权限）');
    }
    if (!/setupMediaSession\(\)/.test(js)) fail('启动时没调用 setupMediaSession()');
    // 播放状态要同步给系统（不然锁屏上一直显示"已暂停"）
    if (!/mediaSession\.playbackState = 'playing'/.test(js)) fail('没把 playing 状态同步给系统');
    if (!/mediaSession\.playbackState = 'paused'/.test(js)) fail('没把 paused 状态同步给系统');
    if (bad === badBefore) console.log('OK    系统媒体控制接好了（歌名/up 主/封面/上一首/播放暂停/下一首/进度条）');
}

// ---------- 37. 一起听：刷新自动回房 + 开房/离开保留歌曲列表 ----------
// 用户 2026/10/16：「加一个一起听的时候刷新以后自动再次进入房间，
// 还有开房和离开的时候保留当前歌曲列表」。
// 后端那半（开房带队列 / pull-queue 合并回来）在 check-room-perms.mjs 里行为验证；
// 这里盯前端这半。
{
    const badBefore = bad;
    // ① 记住房间 + 自动回去
    if (!/const ROOM_KEY = 'hnmusic_room'/.test(js)) fail('没有存房间号的 key（刷新后回不去）');
    if (!/localStorage\.setItem\(ROOM_KEY/.test(js)) fail('进房时没记住房间号');
    if (!/function tryRejoinRoom\(/.test(js)) fail('缺少 tryRejoinRoom()');
    if (!/\.then\(\(\) => tryRejoinRoom\(\)\)/.test(js)) fail('启动链里没调用 tryRejoinRoom（刷新后不会自动回房）');
    // 房间没了要安静忘掉，不能一直报错
    if (!/catch \{\s*forgetRoom\(\);/.test(js)) fail('自动回房失败时没忘掉房间号（会一直报错）');
    if (!/function forgetRoom\(/.test(js)) fail('缺少 forgetRoom()');
    // 分享链接要优先于"自动回上次的房间"（明确点进来的链接不能被覆盖）
    {
        const boot = js.slice(js.indexOf('loadMe()'));
        const iShare = boot.indexOf('joinFromUrl()');
        const iRejoin = boot.indexOf('tryRejoinRoom()');
        if (iShare < 0 || iRejoin < 0 || iShare > iRejoin) fail('启动链里"分享链接"没有排在"自动回房"前面');
    }
    // ② 离开房间前把房间的歌并回自己的队列
    if (!/post\(roomUrl\('\/pull-queue'\)/.test(js)) fail('离开房间时没有把房间队列并回自己的列表');
    {
        const lr = js.slice(js.indexOf('async function leaveRoom('), js.indexOf('async function leaveRoom(') + 900);
        if (!/pull-queue/.test(lr)) fail('leaveRoom() 里没调 pull-queue');
        if (!/catch \{/.test(lr)) fail('leaveRoom() 里的 pull-queue 没有 try/catch（房间没了就走不掉）');
    }
    // ③ 显式退房要清掉记忆（不然下次刷新又自己回去了）
    if (!/forgetRoom\(\)/.test(js)) fail('退出房间时没清掉房间记忆');
    if (bad === badBefore) console.log('OK    一起听：刷新自动回房（分享链接优先）+ 离开时把房间队列并回自己的列表');
}

// ---------- 38. 房间里按 ▶ 要先对上"房间当前那首" ----------
// 用户 2026/10/16 报「按了播放没跳转播放」（确认是按的**播放条上那个 ▶**）：
// 队列面板高亮着房间的第 1 首，播放条却在放他自己队列里的歌 ——
// 这时按 ▶ 只会 pause/play 那首不相干的 ✗
// 修法：先比对 audio 的 dataset.bvid/cid 和 **room 当前曲目**，对不上就先切过去。
{
    const badBefore = bad;
    const tg = (js.match(/\$\('btn-toggle'\)\.addEventListener\('click'[\s\S]*?\n    \}\);/) || [''])[0];
    if (!tg) fail('找不到播放键的处理');
    else {
        // 必须拿 room 的当前曲目来比，不能拿 state.queue（那是**自己**的队列）
        // ⚠️ 而且顺序有讲究：**队列里的当前项优先，room.track 只作兜底** ——
        //    因为队列增量事件不带 track，room.track 可能是旧值
        //    （2026/10/17 "按播放键又没用了" 就是这个旧值导致误判）
        if (!/const rt =\s*\n?\s*\(room\.queue && room\.queue\.items\.find\(\(x\) => x\.id === room\.queue\.currentId\)\) \|\| room\.track;/.test(tg)) {
            fail('房间分支没有"以队列当前项为准"取 rt（room.track 可能是旧值）');
        }
        if (!/onRoomTrack/.test(tg)) fail('房间分支没判断"播放条上这首是不是房间那首"');
        if (!/if \(!onRoomTrack\)/.test(tg)) fail('对不上时没有切过去的逻辑');
        if (!/await applyAudio\(room\)/.test(tg)) fail('对不上时没调 applyAudio(room) 去取流切歌');
        // 用户 2026/10/16 追加要求：「按 ▶ → 切到房间当前那首 → **并且列队调整到对应位置**」。
        // 光靠 afterQueueRender 不行 —— 那里有一条 `if (curId === lastQueueCurId) return`，
        // 按 ▶ 时房间当前项**没变**，所以它直接 return，不滚 ✗
        if (!/const alignQueue = \(\) => setTimeout\(\(\) => scrollQueueToCurrent\('center'\), 0\)/.test(tg)) {
            fail('按 ▶ 没有"把队列面板滚到当前那首"的逻辑（alignQueue）');
        }
        if ((tg.match(/alignQueue\(\);/g) || []).length < 2) {
            fail('alignQueue() 只在一个分支里调了（对不上/对得上两种都要）');
        }
        // ⚠️ 反面：房间里**不能**用 state.queue 兜底（那是自己的队列）
        if (/state\.queue \|\| \{ items: \[\], currentId: null \}/.test(tg) && /if \(room\)/.test(tg)) {
            const roomPart = tg.slice(tg.indexOf('if (room)'), tg.indexOf("if (!a.getAttribute('src')"));
            if (/state\.queue/.test(roomPart)) fail('房间分支里用了 state.queue（会播自己队列的歌）');
        }
    }
    if (bad === badBefore) console.log('OK    房间里按 ▶ 会先切到"房间当前那首"，并把队列面板滚到那一项');

    // 队列定位：必须只滚 #q-list 自己，不能用 scrollIntoView
    //（它会把所有可滚祖先都滚一遍 —— 主列表、整页都跟着跳，按个播放键整页动一下很突兀）
    {
        const fn = (js.match(/function scrollQueueToCurrent\(mode\)[\s\S]*?\n    \}/) || [''])[0];
        if (!fn) fail('找不到 scrollQueueToCurrent()');
        // ⚠️ 要盯**居中那一条分支**本身用没用 scrollTop ——
        //    只查"函数里出现过 ul.scrollTop"太松：另一条分支还在，坏副本照样通过 ✗
        else if (!/if \(centered\) \{\s*ul\.scrollTop =/.test(fn)) {
            fail('scrollQueueToCurrent 居中那条分支没直接改 #q-list 的 scrollTop（可能又用了 scrollIntoView）');
        } else if (!/兜底/.test(fn)) fail('scrollQueueToCurrent 没有说明 scrollIntoView 只是兜底');
    }
}

// ---------- 39. 房间事件别把整个队列面板重建一遍 ----------
// 用户 2026/10/16：「因为找我朋友公开测试了，所以好像每次进来人都会卡一下，
// 我是不是应该换个好一点的服务器」——
// 查下来**不是服务器**（load average 0.04，完全空闲）：服务端每次有人进出房间
// 都会发一条 `you`，客户端收到就 `renderQueue()`，而队列面板是
// `q.items.forEach(...)` **整表重建**（房间队列常见几百上千行 ⇒ 上万个 DOM 节点），
// 每个客户端因此卡几百毫秒。
{
    const badBefore = bad;
    if (!/function renderQueueCoalesced\(/.test(js)) fail('没有 SSE 队列重建的合并逻辑（renderQueueCoalesced）');
    {
        const ore = (js.match(/function onRoomEvent\(event, data\)[\s\S]*?\n    \}/) || [''])[0];
        if (!ore) fail('找不到 onRoomEvent');
        else {
            // you 事件：权限没变就不能重建队列
            const youPart = ore.slice(ore.indexOf("event === 'you'"), ore.indexOf("event === 'grant'"));
            if (!/const same =/.test(youPart)) fail('you 事件没有比对"权限变没变"');
            if (!/if \(!same\) renderQueueCoalesced\(\);/.test(youPart)) {
                fail('you 事件即使权限没变也会重建队列（就是"进来人卡一下"的元凶）');
            }
            // queue- 事件要走合并
            if (!/event\.startsWith\('queue-'\)[\s\S]{0,220}?renderQueueCoalesced\(\);/.test(ore)) {
                fail('queue- 事件没走合并渲染（一串事件会渲好几次）');
            }
            // 这条分支里不能再出现同步的 renderQueue()
            const qPart = ore.slice(ore.indexOf("event.startsWith('queue-')"));
            if (/^\s*renderQueue\(\);/m.test(qPart.split('if (PLAYBACK_EVENTS')[0])) {
                fail('queue- 事件里还有同步 renderQueue()（没走合并）');
            }
        }
    }
    if (bad === badBefore) console.log('OK    房间事件合并渲染 + 权限没变就不重建队列（"进来人卡一下"的根治）');
}

// ---------- 40. 一起听：预热下一首（单人不预热）----------
// 用户 2026/10/16：「让一起听的人会预先加载下一首的曲子，这样也可以预防卡顿，
// 不是一起听则不需要」。
// 关键前提：预热要**真的有用**，必须让真正播放时用**同一个 URL**（否则浏览器缓存
// 对不上，等于白下还把带宽翻倍）。所以前端要有一份 bvid:cid → src 的缓存，
// 后端 /proxy 也要允许音频被缓存（以前是 no-store ✗）。
{
    const badBefore = bad;
    if (!/function preloadNextInRoom\(/.test(js)) fail('没有预热下一首的逻辑（preloadNextInRoom）');
    {
        const fn = (js.match(/function preloadNextInRoom\(\)[\s\S]*?\n    \}/) || [''])[0];
        if (!fn) fail('找不到 preloadNextInRoom');
        else {
            if (!/if \(!room\) return;/.test(fn)) fail('预热没有"只有一起听才做"的限制（单人不该预热）');
            if (!/mode === 'shuffle'\) return;/.test(fn)) fail('随机模式也预热了（猜不到下一首，白费带宽）');
            if (!/mode === 'single'\) return;/.test(fn)) fail('单曲循环也预热了（就是它自己，没必要）');
            if (!/loop-all'\) next = q\.items\[\(idx \+ 1\) % q\.items\.length\]/.test(fn)) {
                fail('列表循环没有从末尾绕回第一首（预热会漏掉那一首）');
            }
            if (!/else next = q\.items\[idx \+ 1\] \|\| null;/.test(fn)) fail('顺序模式没有取"下一项"（或者取错了）');
        }
    }
    // 真正播放时必须复用预热过的 URL
    if (!/const cached = cachedAudioUrl\(track\);/.test(js)) fail('applyAudio 没有优先用预热过的 URL（那样预热白下）');
    if (!/audioUrlCache\.set\(/.test(js)) fail('没有记录已解析的音频地址（audioUrlCache）');
    if (!/const AUDIO_URL_TTL/.test(js)) fail('音频地址缓存没有时效（签名会过期）');
    // 后端：/proxy 必须允许音频被浏览器缓存
    const backend = fs.readFileSync(path.join(HERE, '..', 'src', 'index.js'), 'utf8');
    if (!/isImg \? 'public, max-age=604800, immutable' : 'private, max-age=21600, immutable'/.test(backend)) {
        fail('后端 /proxy 没给音频发可缓存的头（no-store 的话预热等于白下）');
    }
    if (bad === badBefore) console.log('OK    一起听预热下一首（单人不预热、随机/单曲跳过、播放时复用同一 URL）');
}

// ---------- 41. 队列事件按增量更新（服务端只发变化的那点）----------
// 2026/10/16 改：以前每个队列事件都带整份队列（1000 首 ≈ 280 KB × 每个听众），
// 服务器上行 400 KB/s 里一大半是这个。协议的行为验证在
// scripts/check-queue-delta.mjs（挂真 SSE、把增量自己应用一遍再跟服务端比对）；
// 这里盯客户端**这五条分支**都在，免得以后有人只改了一半。
{
    const badBefore = bad;
    if (!/function applyQueueDelta\(roomState, event, data\)/.test(js)) fail('缺少 applyQueueDelta()（队列增量应用）');
    {
        const fn = (js.match(/function applyQueueDelta\(roomState, event, data\)[\s\S]*?\n    \}/) || [''])[0];
        if (!fn) fail('找不到 applyQueueDelta 的函数体');
        else {
            const branches = [
                ['data\\.queue', '旧整份报文兜底'],
                ['data\\.cleared', '清空'],
                ['Array\\.isArray\\(data\\.items\\)', '批量加'],
                ['data\\.item', '单加（含 afterId 定位）'],
                ['data\\.itemId', '删除'],
                ['Array\\.isArray\\(data\\.order\\)', '只发顺序的重排'],
                ['data\\.currentId !== undefined', '同步当前曲目'],
            ];
            for (const [re, label] of branches) {
                if (!new RegExp(re).test(fn)) fail('applyQueueDelta 少了「' + label + '」这条分支');
            }
            // 单加那条必须看 afterId 来决定插哪儿 ——
            // ⚠️ 要盯**判断条件本身**：只查"函数里出现过 data.afterId"太松，
            //    分支体里本来就有它，坏副本照样通过 ✗（第一次就是这么漏的）
            if (!/if \(data\.moved \|\| data\.afterId !== undefined\) \{/.test(fn)) {
                fail('applyQueueDelta 的单加分支没按 afterId 判断（"下一位"会插错地方）');
            }
            // 重排那条不能把没提到的歌弄丢
            if (!/for \(const it of byId\.values\(\)\) next\.push\(it\)/.test(fn)) {
                fail('applyQueueDelta 的重排有丢歌风险（order 里没提到的没兜底）');
            }
        }
    }
    // 事件处理里要调它（而不是自己再写一遍）
    if (!/applyQueueDelta\(room, event, data\);/.test(js)) fail('onRoomEvent 没调用 applyQueueDelta');
    // 服务端这边也不能再广播整份队列
    const rooms = fs.readFileSync(path.join(HERE, '..', 'src', 'rooms.js'), 'utf8');
    const full = rooms.split('\n').filter((l) => /broadcast\(room, 'queue-/.test(l) && /queue: ?q/.test(l));
    if (full.length) fail('服务端还在广播整份队列: ' + full.length + ' 处');
    if (!/function afterIdOf\(q, item\)/.test(rooms)) fail('服务端缺少 afterIdOf()（客户端不知道插在哪儿）');
    if (!/function orderOf\(q\)/.test(rooms)) fail('服务端缺少 orderOf()（重排只发顺序要用）');
    if (bad === badBefore) console.log('OK    队列事件按增量走（客户端 7 条分支齐 + 服务端不再发整份队列）');
}

// ---------- 42. 点 ▶ 在"刚上线、什么都没播"时必须真的播起来 ----------
// 用户 2026/10/16 报两次：「点击还是没用」「我懂了，点击那个播放在刚上线
// 什么都没播放的时候会失效」。两个成因，各自钉住：
//   ① 单人：队列是空的（刚部署完就是这样），但屏幕上摆着一个歌单/推荐列表 ——
//      以前只会说"列表里还没有歌" ✗
//   ② 一起听：房间分支只给服务端发 play，等 SSE 回来才 play() ——
//      那一会儿已经脱离点击手势了，浏览器当场把 play() 当自动播放拒掉 ✗
{
    const badBefore = bad;
    const tg = (js.match(/\$\('btn-toggle'\)\.addEventListener\('click'[\s\S]*?\n    \}\);/) || [''])[0];
    if (!tg) fail('找不到播放键的处理');
    else {
        // ① 兜底到"屏幕上第一行"
        if (!/\$\('list'\)\.querySelector\('li\.row'\)/.test(tg)) {
            fail('队列为空时没有兜底到"屏幕上那一列的第一个"（会一直说"列表里还没有歌"）');
        }
        if (!/await playNext\(await resolveBvid\(bvid\)\)/.test(tg)) {
            fail('兜底没有把屏幕上第一首加进队列并播（应该走 playNext + resolveBvid）');
        }
        // ② 房间里要**同步** play，不能等 SSE
        if (!/const p = a\.play\(\);/.test(tg)) {
            fail('房间里没有同步调用 a.play()（脱离点击手势后会被浏览器拒掉）');
        }
        if (!/a\.pause\(\); \/\/ 服务端不让/.test(tg)) {
            fail('服务端拒绝后没有把本地播放退回去（会偷偷自己播）');
        }
        // 顺序：同步 play() 必须在发请求之前
        // ⚠️ 2026/10/17：play 指令改成**不带 position**了（原来会拿本地进度覆盖房间 ✗
        //    ⇒ 本地 245 秒发给服务器 ⇒ 服务器立刻"放完"跳下一首 ✗）。断言跟着更新：
        //    只要求"有 play 指令"，且它排在 a.play() 之后 ✓
        {
            const iPlay = tg.indexOf('const p = a.play();');
            const iCtl = tg.indexOf("await roomControl({ action: 'play' });");
            if (iPlay < 0 || iCtl < 0 || iPlay > iCtl) {
                fail('a.play() 没有排在发请求之前（点击手势就浪费了）', { iPlay, iCtl });
            }
        }
        // 反面：再出现"带 position 的 play"就是回退 ✗
        if (/roomControl\(\{ action: 'play', position:/.test(js)) {
            fail('房间的 play 又把本地进度发给服务器了（会覆盖房间进度 ⇒ 立刻跳下一首 ✗）');
        }
    }
    if (bad === badBefore) console.log('OK    点 ▶ 的两个成因都堵上了（队列空→播屏幕第一首；房间里→手势内同步 play）');
}

// ---------- 43. 左栏"相关推荐" ----------
// 用户 2026/10/16：「歌单那一栏下面再加一栏"相关推荐"，显示的是当前播放曲目的
// b 站相关推荐那一栏的前十首，每首的按钮只有那个图表化的播放和下一首就行了」。
// 接口的行为验证在一次性冒烟里做过（真去问 B 站，10 项全过）；
// 这里盯前端这部分：那一栏在、跟着当前曲目刷新、只有那两个按钮、拉不到要收起。
{
    const badBefore = bad;
    if (!/id="rel-box"/.test(html)) fail('HTML 里没有"相关推荐"那一栏（#rel-box）');
    if (!/id="rel-list"/.test(html)) fail('HTML 里没有相关推荐的列表容器（#rel-list）');
    if (!/<span>相关推荐<\/span>/.test(html)) fail('那一栏的标题不是"相关推荐"');
    if (!/function refreshRelated\(bvid\)/.test(js)) fail('缺少 refreshRelated()');
    if (!/function renderRelated\(/.test(js)) fail('缺少 renderRelated()');
    // ⚠️ 别写成 `related?bvid=[^']*limit=10`：中间还夹着 encodeURIComponent(want) 的引号，
    //    那个写法永远匹配不上（第一版就是这么假红的）。放宽成"这俩在 80 字符内"
    if (!/\/api\/bili\/related\?bvid=[\s\S]{0,80}?limit=10/.test(js)) fail('没有按"前十首"取（limit=10）');
    {
        // 参数名从 items 改成 rawItems（过滤禁词），所以这里按函数名截，别写死参数名
        const fn = (js.match(/function renderRelated\([\s\S]*?\n    \}/) || [''])[0];
        if (!fn) fail('找不到 renderRelated 的函数体');
        else {
            if (!/playNext\(it\)/.test(fn)) fail('相关推荐里没有"▶ 马上播"');
            if (!/enqueue\(it, true\)/.test(fn)) fail('相关推荐里没有"下一首（只排队、不打断）"');
            // 用户明确说"按钮只有这两个" ⇒ **直接数**按钮个数最稳：
            // 查关键字会被大小写绕过（第一版查小写 `del`，而代码里是 `bDel` ✗）
            const btnCount = (fn.match(/document\.createElement\('button'\)/g) || []).length;
            if (btnCount !== 2) fail('相关推荐里的按钮不是两个（用户只要 ▶ 和 下一首）', btnCount);
            if (!/img\.loading = 'lazy'/.test(fn)) fail('相关推荐的封面没有懒加载（10 张一起下没必要）');
        }
        if (!/rel-box'\)\.hidden = true/.test(js)) fail('接口失败时没把那一栏收起来（会留个空框）');
    }
    // 跟着当前曲目刷新：单人播放 + 一起听切歌，两条路都要挂
    if (!/refreshRelated\(bvid\);/.test(js)) fail('playMedia 里没有刷新相关推荐（单人听歌时那一栏是死的）');
    if (!/refreshRelated\(track\.bvid\);/.test(js)) fail('一起听切歌时没有刷新相关推荐');
    if (bad === badBefore) console.log('OK    左栏"相关推荐"（前十首、只有 ▶ 和 下一首、跟着当前曲目、拉不到就收起）');
}

// ---------- 44. 房间分享链接：短路径 /r/<token> ----------
// 用户 2026/10/17：「分享一起听房间链接以后，能直接以游客身份加入到该房间来
// （已登录用户就用登陆的账号）」—— 这条**本来就能用**（探针验过：全新游客点
// 链接直接进房；已登录的用登录账号进房），而且链接是 location.origin 拼的 ⇒
// 前面是 IP 还是域名都无所谓 ✓
// 这里盯的是"美化成 /r/<token>"那一步（用户朋友建议的"自定义 path 部分"）：
//   · 生成的是 /r/<token>
//   · 两种形式都要能读（**老链接已经发给朋友了，绝不能失效** ✗）
//   · 地址栏要抹干净（别把 token 留在历史记录里）
{
    const badBefore = bad;
    // ⚠️ 这里一律用 .includes(纯字符串) 判断，别写正则字面量 ——
    //    里面的 `/` 会把正则字面量截断（第一版就是这么把自己的脚本写崩的 ✗）
    if (!js.includes("location.origin + '/r/' + encodeURIComponent(r.token)")) {
        fail('分享链接不是 /r/<token> 短路径形式');
    }
    const fn = (js.match(/async function joinFromUrl\(\)[\s\S]*?\n    \}/) || [''])[0];
    if (!fn) fail('找不到 joinFromUrl');
    else {
        if (!fn.includes("new URLSearchParams(location.search).get('room')")) {
            fail('joinFromUrl 不认老的 ?room= 形式（已经发出去的老链接会失效）');
        }
        if (!fn.includes('location.pathname.match(') || !fn.includes('/^\\/r\\/')) {
            fail('joinFromUrl 不认新的 /r/<token> 形式');
        }
        if (!fn.includes("history.replaceState(null, '', '/')")) {
            fail('进房后没把地址栏抹干净（token 会留在历史记录里）');
        }
    }
    const backend = fs.readFileSync(path.join(HERE, '..', 'src', 'index.js'), 'utf8');
    if (!backend.includes('p.match(/^\\/r\\/[A-Za-z0-9_-]{4,64}')) {
        fail('后端没有把 /r/<token> 当首页发（前端会拿到 404）');
    }
    if (bad === badBefore) console.log('OK    房间分享链接：/r/<token> 短路径 + 老 ?room= 仍然认 + 地址栏抹干净');
}

// ---------- 45. 客户端房间状态必须自洽（track/trackId 不能停在旧值）----------
// 2026/10/17 用户第二次报「按这个播放键又没用了」，查下来是**队列增量改动的副作用**：
//   增量事件只带 currentId，而客户端只更新了 queue.currentId，
//   room.track / room.trackId 还停在上一次 play 报文那一首 ⇒
//     ① ▶ 分支误判"已经在这首上" → 只给服务端发指令，本地什么都不做
//     ② applyAudio 的守卫 `room.queue.currentId !== track.id` → 直接 return
//   两条叠加 → 房间里的播放指令**完全变空操作** ✗
// 所以：只要 currentId 变了，track/trackId 必须一起对齐。
{
    const badBefore = bad;
    const od = (js.match(/function applyQueueDelta\(roomState, event, data\)[\s\S]*?\n    \}/) || [''])[0];
    if (!od) fail('找不到 applyQueueDelta');
    else {
        if (!/roomState\.trackId = q\.currentId;/.test(od)) fail('增量应用后没有对齐 trackId（会停在旧值）');
        if (!/roomState\.track = q\.items\.find\(\(x\) => x\.id === q\.currentId\) \|\| null;/.test(od)) {
            fail('增量应用后没有对齐 track（房间播放指令会变成空操作）');
        }
        if (!/if \(data\.currentId !== undefined\) q\.currentId = data\.currentId;/.test(od)) {
            fail('增量应用没处理 currentId');
        }
    }
    const ap = (js.match(/function applyPlayback\(data\)[\s\S]*?\n    \}/) || [''])[0];
    if (!ap) fail('找不到 applyPlayback');
    else if (!/room\.trackId = data\.trackId;/.test(ap)) {
        fail('applyPlayback 没同步 trackId（队列面板"滚到当前那首"会一直用旧值）');
    }
    if (bad === badBefore) console.log('OK    客户端房间状态自洽（currentId 一变，track/trackId 一起对齐）');
}

// ---------- 46. 不要在界面里用原生 confirm / prompt / alert ----------
// 用户 2026/10/17：「解散房间也应该是弹窗而不是这样」（发来的是浏览器原生 confirm 的截图 ✗）。
// 原生那些长的是"系统对话框"的样子，和整个界面对不上，而且部分浏览器还能被勾"不再提示"✗
// 所以全部换成应用自己的弹窗（confirmModal / promptModal）。
{
    const badBefore = bad;
    // ⚠️ 匹配调用处要避开定义和注释：直接找 `confirm(` 这类"调用"形态
    const nativeCalls = [
        [/(^|[^.\w'"`])confirm\s*\(/m, 'confirm('],
        [/(^|[^.\w'"`])prompt\s*\(/m, 'prompt('],
        [/(^|[^.\w'"`])alert\s*\(/m, 'alert('],
    ];
    for (const [re, label] of nativeCalls) {
        // 去掉注释再找（注释里提到 confirm 不算）
        const noComment = js.replace(/^\s*\/\/.*$/gm, '');
        if (re.test(noComment)) fail('界面里还在用原生 ' + label + '（应该用应用自己的弹窗）');
    }
    if (!/function confirmModal\(/.test(js)) fail('缺少 confirmModal()');
    if (!/function promptModal\(/.test(js)) fail('缺少 promptModal()');
    // 四处确认 + 一处输入都该换成弹窗版
    if (!/await confirmModal\(\{/.test(js)) fail('没有任何地方用 confirmModal（换了等于没换）');
    if (!/await promptModal\(\{/.test(js)) fail('没有地方用 promptModal（重命名还是原生输入框）');
    // 确认框正文**不能**用 .modal-msg（那是 --danger 红色，给报错用的 ——
    // 一片红看着像"已经出错了"，这个是出例图时才发现并改掉的）
    {
        const cm = (js.match(/function confirmModal\([\s\S]*?\n    \}/) || [''])[0];
        if (!/p\.className = 'modal-text'/.test(cm)) fail('确认框正文没用中性色的 .modal-text（红色像报错）');
        if (/p\.className = 'modal-msg'/.test(cm)) fail('确认框正文还在用红色的 .modal-msg');
    }
    if (bad === badBefore) console.log('OK    没有原生 confirm/prompt/alert（全换成应用自己的弹窗，且确认文案不是红的）');
}

// ---------- 47. 进度对齐不能把"暂停"变成"调进度" ----------
// 2026/10/17 用户："我怎么按暂停变成调整进度了"。
// 根因：每次播放广播（含 pause/playback）只要和本地偏差 >0.6 秒就拉 a.currentTime，
// 而本地开播总比服务端账上晚一点 ⇒ 一按暂停，播放头就跳一下 ✗
// 规矩：换了曲子**必须**对齐；同一首之内只有"在播 且 偏差很大"才纠正（暂停绝不动进度）。
{
    const badBefore = bad;
    // 不切函数体（那几个 `}` 缩进不好抓 ✗）—— 这几串在全文里都是唯一的，直接查全文
    if (!/const bigDrift = drift > 8;/.test(js)) fail('没有"偏差很大才纠正"的门槛（小的漂移不该动进度）');
    // ⚠️ 别再钉"形"—— 这一行后来还多了一个暂停锁的前置条件 ✗
    //    现在只要求：**在播 + 偏差大** 才纠正，而且外面一定套着 progressLocked ✓
    if (!/\(data\.isPlaying && bigDrift\)/.test(js)) {
        fail('进度对齐没有"暂停绝不动进度"这条（按暂停会变成调进度）');
    }
    if (!/!progressLocked && [\s\S]{0,40}?\(data\.isPlaying && bigDrift\)/.test(js)) {
        fail('进度对齐没有把暂停锁算进去（按暂停会变成调进度）');
    }
    if (/Math\.abs\(a\.currentTime - pos\) > 0\.6\) a\.currentTime =/.test(js)) {
        fail('还是老写法：不看在不在播、偏差 >0.6 秒就拉进度 ✗');
    }
    if (bad === badBefore) console.log('OK    进度对齐：换曲子必对齐；同一首只有"在播且偏差大"才纠正（暂停不动进度）');
}

// ---------- 48. 事件流看门狗（半开连接的自愈）----------
// 2026/10/17 用户："按暂停变成调进度、没办法拖动进度条、不能自动播放下一首，
// 我怀疑全部为同一个问题 → 本地操作未能成功上传服务器"。
// 查下来服务端整趟都好（实测：登录 200、SSE 200、pause/seek 都 200 且生效、广播都回来），
// 所以是**回程断了**：fetch 版 SSE 没有 EventSource 的自动重连，而"半开"的连接
// 会让 reader.read() 永远不返回（不报错、不结束）⇒ 上面那段重连逻辑压根不触发 ✗
// ⇒ 表现就是"指令发得出去、什么都收不回来"：暂停没反应、进度条拖不动、不自动切歌 ✓
// 修法：服务端每 20 秒发 `: ping` 心跳，客户端记"最后收到字节的时间"，
//      55 秒没动静就 abort + 重连 + 补拉一次状态。
{
    const badBefore = bad;
    if (!/let lastStreamAt = 0;/.test(js)) fail('没有"最后收到字节的时间"这个变量（看门狗没法判断）');
    if (!/lastStreamAt = Date\.now\(\); \/\/ 刚打开先算活的/.test(js)) fail('打开流时没有把活跃时间置为现在');
    // 活跃度必须记在 reader 循环里：`handleSse()` 会把 `: ping` 当注释跳过 ✗
    const loop = (js.match(/const reader = r\.body\.getReader\(\);[\s\S]*?for \(;;\) \{[\s\S]*?\n                \}/) || [''])[0];
    if (!/if \(done\) break;\s*\n\s*\/\/[\s\S]{0,200}?lastStreamAt = Date\.now\(\);/.test(loop)) {
        fail('reader 循环里没记活跃时间（心跳是注释，记在 handleSse 里就永远不更新 ✗）');
    }
    if (!/Date\.now\(\) - lastStreamAt < 55000/.test(js)) fail('看门狗没有"55 秒没数据就重连"的判断');
    if (!/openRoomStream\(rid\);/.test(js)) fail('看门狗判定断开后没有重连');
    if (!/jfetch\('\/api\/rooms\/' \+ encodeURIComponent\(rid\)\)/.test(js)) {
        fail('重连后没有补拉一次房间状态（断的这段时间可能已经切歌了）');
    }
    // 本地要**立刻**反馈：暂停和拖动进度不能只发指令等服务端广播
    //（回程断了就变成"按了没反应"，2026/10/17 用户报的）
    // ⚠️ 别要求两句"紧挨着"—— 中间还可能有别的（比如暂停锁），
    //    钉死相邻会让断言变成摆设/误报（2026/10/17 就被自己的断言拦了一次 ✗）
    if (!/a\.pause\(\);[\s\S]{0,400}?await roomControl\(\{ action: 'pause' \}\)/.test(js)) {
        fail('房间里按暂停时本地没有先停（a.pause() 之后才发指令）');
    }
    // 暂停锁：只锁**进度**，绝不能吞掉广播 ✗
    //（2026/10/17 第一版就是锁里 `return` ⇒ 1.5 秒内连"播放"和"切歌"都被吞 ✓
    //  用户直接感觉"暂停键又坏了" ⇒ 这条断言专门防我再写回去）
    if (!/let pauseLockUntil = 0;/.test(js)) fail('没有暂停锁变量');
    if (!/const progressLocked = Date\.now\(\) < pauseLockUntil;/.test(js)) fail('暂停锁没有算成 progressLocked');
    if (!/if \(!progressLocked && \(!same \|\| \(data\.isPlaying && bigDrift\)\)\)/.test(js)) {
        fail('进度对齐没有把暂停锁算进去（按暂停会变成调进度）');
    }
    if (!/pauseLockUntil = Date\.now\(\) \+ 1500;/.test(js)) fail('按下暂停时没有上锁');
    // 反面：锁里出现 `return` 就是吞广播的写法 ✗
    if (/if \(Date\.now\(\) < pauseLockUntil\) \{[\s\S]{0,200}?return;/.test(js)) {
        fail('暂停锁里又出现了 return（会吞掉这 1.5 秒内的播放/切歌广播 ✗）');
    }
    if (!/try \{ a\.currentTime = pos; \}[\s\S]{0,140}?await roomControl\(\{ action: 'seek', position: pos \}\)/.test(js)) {
        fail('房间里拖进度条只发指令、本地不立刻跳（回程断了就拖不动）');
    }
    if (bad === badBefore) console.log('OK    事件流看门狗（半开连接会自己重连 + 补拉状态）');
}

// ---------- 49. 令牌失效时不许"静默降级成游客" ----------
// 2026/10/17 用户报"按暂停没反应 / 拖不动进度条 / 不会自动切下一首 —— 我怀疑全是同一个问题"。
// 其中一个成因就是：账号令牌一失效，客户端**悄悄**换一个游客身份继续跑 ✗
// ⇒ 人不再是房间成员 ⇒ 房间里所有操作都废，而界面看着还"登录着" ✗
// 规矩：带着**账号**令牌被 401 ⇒ 明确提示重新登录；只有本来就是游客才重领 ✓
{
    const badBefore = bad;
    // ① jfetch：401 且本来就该是登录用户 ⇒ 抛错让上层提示，不静默换游客
    if (!/const wasUser = lostIdentity && !!token &&/.test(js)) {
        fail('jfetch 没有区分"刚才是不是登录状态"');
    }
    if (!/if \(wasUser\) \{[\s\S]{0,160}?hint\('登录已过期/.test(js)) {
        fail('jfetch 在账号令牌失效时没有提示重新登录（会静默变游客）');
    }
    // ② loadMe：会话不存在时同样要判断"这台设备本来是不是登录状态"
    if (!/if \(wasLoggedInUser\(\)\) \{/.test(js)) {
        fail('loadMe 没有判断"本来是不是登录状态"（打开页面时会静默降级成游客）');
    }
    // ③ 标记本身要在登录/注册时写上、登出时清掉
    if (!/const USER_KEY = 'hnmusic_logged_in';/.test(js)) fail('没有"这台设备登录过"的标记');
    const setCount = (js.match(/markUser\(true\)/g) || []).length;
    if (setCount < 3) fail('登录/注册/改密成功时没有都写标记（现在 ' + setCount + ' 处）');
    if (!/markUser\(false\); \/\/ 主动登出/.test(js)) fail('主动登出时没清标记（以后会一直提示重新登录）');
    if (bad === badBefore) console.log('OK    令牌失效不静默降级（账号失效提示重登；游客才重领）');
}

// ---------- 50. 个人中心的"扫码登录 B站 小号"（管理员专属）----------
// 2026/10/17 用户："登陆扫码的入口塞到管理员的个人中心当中"。
// 走 B站 的扫码登录接口（generate/poll），不用无头浏览器 —— 后者会被识别成自动化 ✗。
// 这里盯三件事：入口只在管理员那里渲染、两个接口路径没写错、轮询真的会停。
{
    const badBefore = bad;
    // 2026/10/19 重写后：入口从"个人中心里的一行"改成**顶栏按钮 + 浮层**
    //（syncAdminButtons 按角色显隐；浮层里显示服务端画好的二维码）。
    // 守的东西没变：只给管理员、两个接口、轮询一定会停。
    if (!/async function openQrLogin\(/.test(js)) fail('没有 openQrLogin()（扫码入口）');
    if (!/function closeQrLogin\(/.test(js)) fail('没有 closeQrLogin()（关掉浮层时停轮询）');
    if (!/function syncAdminButtons\(/.test(js)) fail('没有 syncAdminButtons()（管理员专属入口的显隐）');
    {
        const sa = (js.match(/function syncAdminButtons\([\s\S]*?\n    \}/) || [''])[0];
        if (!/me && me\.role === 'admin'/.test(sa)) fail('扫码/收藏入口没有限制成管理员专属');
        if (!/qrBtn\.hidden/.test(sa)) fail('扫码按钮的显隐没跟着角色走');
    }
    if (!/post\('\/api\/admin\/bili-login\/start'/.test(js)) fail('没有调用 /api/admin/bili-login/start');
    if (!/post\('\/api\/admin\/bili-login\/poll'/.test(js)) fail('没有调用 /api/admin/bili-login/poll');
    if (!/setInterval\(async \(\) => \{/.test(js)) fail('没有轮询扫码状态');
    if (!/clearInterval\(qrPollTimer\)/.test(js)) fail('轮询没有停下来的地方（关了浮层还在打接口 ✗）');
    if (!/qr-img/.test(js)) fail('没有二维码图片的元素');
    if (!/function closeQrLogin\([\s\S]{0,200}?ov\.remove\(\)/.test(js)) {
        fail('浮层关掉后没有从 DOM 里移除（每开一次就多叠一层）');
    }
    if (bad === badBefore) console.log('OK    扫码登录小号（管理员顶栏入口 + 浮层 + 两个接口 + 轮询会停）');
}

console.log('INFO script 标签在第 ' + head.split('\n').length + ' 行');

console.log(bad ? '\n结果: 有问题（' + bad + ' 项）' : '\n结果: 全部通过');
process.exit(bad ? 1 : 0);
