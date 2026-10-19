// 按设备尺寸截图（改完样式用来"看一眼"）。
//   node scripts/shoot.mjs                        默认截本地 8080
//   node scripts/shoot.mjs http://124.220.169.253:8443   截线上
// 图片落在系统临时目录，不污染仓库。
//
// ⚠️ 两个踩过的坑，别再踩：
//   ① Windows 上 Edge/Chrome 无头窗口有**最小宽度**（约 500px）。
//      `--window-size=390` 出来的视口其实是 ~496 —— 截图只是把右边裁掉，
//      看起来像"布局横向溢出"，纯属假象（我为此白查了一轮）。
//   ② `--window-size` 是 **CSS 像素**，`--force-device-scale-factor` 只改输出分辨率。
//      所以给 500px 以下做验证只能靠 **iframe**：iframe 里的媒体查询
//      按 iframe 的宽度生效，正好能精确模拟 390px 的手机。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const EDGE_CANDIDATES = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const BROWSER = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) {
    console.log('没找到 Edge/Chrome，跳过截图');
    process.exit(0);
}

// ⚠️ 变量名别叫 URL —— 会把全局 URL 构造函数遮住，
//    后面 `new URL(import.meta.url)` 就跑不起来了（第一次就栽在这）
const TARGET = process.argv[2] || 'http://localhost:8080';
const OUTDIR = process.argv[3] || path.join(os.tmpdir(), 'hnmusic-shots');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAME = path.join(ROOT, 'public', '_frame.html'); // 临时页面，跑完必删
const PROFILE = path.join(os.tmpdir(), 'hnmusic-edge-profile');

const FRAMES = [
    { name: 'phone-390', w: 390, h: 780 },
    { name: 'phone-430', w: 430, h: 860 },
    { name: 'ipad-portrait-768', w: 768, h: 900 },
    { name: 'ipad-landscape-1024', w: 1024, h: 700 },
    { name: 'laptop-1280', w: 1280, h: 760 },
];

fs.mkdirSync(OUTDIR, { recursive: true });
try {
    for (const f of FRAMES) {
        fs.writeFileSync(
            FRAME,
            `<!doctype html><meta charset="utf-8"><style>
               body{margin:0;background:#333;font:12px monospace;color:#fff}
               .lab{padding:4px 8px}
               iframe{display:block;border:0;background:#fff}
             </style><div class="lab">${f.name} — ${f.w}x${f.h}</div>
             <iframe src="${TARGET}" width="${f.w}" height="${f.h}"></iframe>`
        );
        const out = path.join(OUTDIR, f.name + '.png');
        fs.rmSync(out, { force: true });
        spawnSync(
            BROWSER,
            [
                '--headless=new',
                '--disable-gpu',
                '--hide-scrollbars',
                '--user-data-dir=' + PROFILE,
                '--virtual-time-budget=9000',
                '--window-size=' + (f.w + 20) + ',' + (f.h + 40),
                '--screenshot=' + out,
                'http://localhost:8080/_frame.html',
            ],
            { stdio: 'ignore' } // 沙箱里用管道捕获子进程输出会被拒
        );
        console.log('  ' + f.name.padEnd(22) + (fs.existsSync(out) ? Math.round(fs.statSync(out).size / 1024) + ' KB  ' + out : '失败'));
    }
} finally {
    fs.rmSync(FRAME, { force: true });
    console.log('  （临时页面 public/_frame.html 已删）');
}
