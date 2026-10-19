// 这个 cookie 属于哪个 B站 账号？—— 在你本机跑，cookie 不会被上传，也不会打印出来。
//
// 用法（把两个 SESSDATA 各写一行到 .bili-cookie.txt，然后跑）：
//   node scripts/check-bili-cookie.mjs
// 输出里会写：第 1 行属于「某某」、第 2 行属于「某某」⇒ 留下小号那一行 ✓
//
// 原理：B站 的 nav 接口会按当前登录态返回 mid/uname/isLogin ⇒ 一问就知道是谁 ✓
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(HERE, '..', '.bili-cookie.txt');
const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

if (!fs.existsSync(file)) {
    console.log('找不到文件：' + file);
    console.log('把 cookie 写进这个文件（每行一个）：');
    console.log('  SESSDATA=第一串');
    console.log('  SESSDATA=第二串');
    process.exit(1);
}

const lines = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));

if (!lines.length) {
    console.log('文件里没有内容（每行写一个 SESSDATA=...）');
    process.exit(1);
}

const mask = (cookie) => {
    // 只露前 6 位，够你区分两行、又不足以被拿去用
    const m = cookie.match(/SESSDATA=([^;]+)/);
    const v = m ? m[1] : cookie;
    return v.slice(0, 6) + '…（' + v.length + ' 字符）';
};

console.log('  文件：' + file);
console.log('  共 ' + lines.length + ' 个 cookie，逐个问 B站"这是谁"…');
console.log('');

for (let i = 0; i < lines.length; i++) {
    const cookie = lines[i];
    const tag = '  第 ' + (i + 1) + ' 行 [' + mask(cookie) + ']';
    if (!/SESSDATA=/.test(cookie)) {
        console.log(tag + ' ✗ 里面没有 SESSDATA=，不是有效 cookie');
        continue;
    }
    try {
        const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
            headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: cookie },
        });
        const j = await r.json();
        const d = j.data || {};
        if (j.code === 0 && d.isLogin) {
            console.log(tag + ' ⇒ 账号：' + d.uname + '  (mid ' + d.mid + ', 等级 ' + (d.level ?? '?') + ')');
        } else if (j.code === -101 || d.isLogin === false) {
            console.log(tag + ' ⇒ ✗ 已失效/未登录（B站 code ' + j.code + '）');
        } else {
            console.log(tag + ' ⇒ ? B站 返回 code ' + j.code + ' ' + (j.message || ''));
        }
    } catch (e) {
        console.log(tag + ' ⇒ ✗ 请求失败：' + e.message + '（本机能上 bilibili.com 吗？）');
    }
    await new Promise((r) => setTimeout(r, 400)); // 别连着打
}

console.log('');
console.log('  ⇒ 认出是小号的那一行留下，另一行删掉，然后跑：');
console.log('      powershell -ExecutionPolicy Bypass -File scripts\\set-bili-cookie.ps1');
