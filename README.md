# HnMusic · 术曲电台

一个自用的 VOCALOID/术力口 音乐站：**零依赖 Node 后端 + 单文件前端 + 安卓壳**。
核心特色是「**心动模式**」——一个按个人口味反复调出来的推荐器（不是简单的随机/热门）。

线上地址：`http://124.220.169.253:8443`（HTTP，暂未上 TLS）

---

## 目录结构

```
src/                 后端（Node 20，零 npm 依赖）
  index.js           HTTP 路由（43 个接口，见 docs/API.md）
  bili.js            B站接口封装：取流 / 相关推荐 / 收藏夹 / 歌姬与 P主 解析
  auth.js            账号与权限（scrypt 密码哈希、邀请码、角色）
  room.js            「一起听」房间（SSE 广播、队列、心跳）
public/
  index.html         整个前端（单文件，约 5800 行；无构建步骤）
  assets/            字体与图标许可证
scripts/             运维与自检脚本（部署、体检、预演、数据分类）
app/
  android/           安卓壳（WebView + 前台服务）；GitHub Actions 自动编译
  tools/             服务器上编译用的辅助脚本
docs/API.md          所有 HTTP 接口
PROJECT.md           开发日志（改了什么、为什么改、踩过的坑）
DEPLOY.md            部署流程
```

**前端没有构建工具**：`public/index.html` 直接部署就是最新版。所有改动 `deploy.ps1` 一跑就生效。

---

## 本地跑起来

```bash
node src/index.js          # 默认 http://127.0.0.1:8443
```

需要 Node ≥ 20，无 npm install。

---

## 安卓 app（`app/android`）

**设计要点：壳只加载线上 URL，不在本地打包前端。**

```
MainActivity.java     WebView 加载 http://124.220.169.253:8443
                      · DOM Storage / 允许自动播放 / 允许混合内容（因为站点是 HTTP）
                      · 返回键：先 WebView 后退，退到底再退出
PlaybackService.java  前台服务 + 常驻通知 ⇒ 息屏/切后台不被系统杀播放
```

所以：**网页改多少次都不用重新打包 APK**，只有改壳（图标、权限、保活策略）才需要。

### 编译（GitHub Actions，推荐）

推送到 `main` 就会自动编（`.github/workflows/build-apk.yml`），产物在 Actions 页面底部的 Artifacts —— `hnmusic-apk.zip`。

想用**固定签名**（能覆盖安装旧版）：把 keystore base64 后放进仓库 Secret `HN_KS_BASE64`：

```bash
base64 -w0 app/hnmusic.jks     # 结果贴进 Settings → Secrets → HN_KS_BASE64
```

没配就走 debug 签名（能装、但不能覆盖 release 版）。

### 编译（本机/服务器，备选）

```bash
app/tools/install-sdk.sh   # 装 JDK17 + Android SDK（Ubuntu）
app/tools/build-apk.sh     # 编 release APK
```

> ⚠️ 国内服务器直连 `services.gradle.org` / `maven.google.com` 基本会卡死，所以默认走 GitHub Actions。

---

## 心动模式（项目核心）

候选来自 B站 的 **相关推荐**（`archive/related`，不受限流影响）+ **收藏夹兜底池**。
每首都过一套规则，权重按播放量、P主、歌姬历史衰减，最后**加权随机**。

选完还会**验一次简介**（只验选中的那首，不是整批），确认是歌、补歌姬/P主、和上一首比重复。

完整规则演进写在 `PROJECT.md`（搜「心动模式」），关键几条：

| 规则 | 说明 |
|---|---|
| 禁词 | ~120 条：搬运/翻唱/切片/演奏/音游/歌词鉴赏… 命中即跳过 |
| 名字黑名单 | `八ツ橋荟肉肉`、`电机` |
| 三连同P主 | 连续三首同 P主 硬禁（合作曲按 P主 集合算） |
| 同歌姬降权 | 推荐栏里同歌姬 ≥6 首 ⇒ 权重 ×0.4（初音ミク 除外） |
| 判重 | 歌名核（剥元信息/歌姬/署名）+ 片假名↔拉丁骨架 + 公共前缀 + 同P主&时长 |
| 选中后验简介 | 标题不像歌名 / 歌姬没认出 / 歌姬不在名单 ⇒ 扒 1 次简介 |
| 强制插入 | 连续同歌姬（非初音 >4 / 初音 >8）或连续"歌姬不可信" >3 ⇒ 收藏夹第 400 首之后随机 10 挑 1 |
| P主 白名单 | 从收藏夹统计"出现 ≥2 次"的名字（908 个），解析标题时已知的优先 |

---

## 自检脚本

```bash
node scripts/check-live.mjs        # 线上 34 项巡检
node scripts/check-frontend.mjs    # 前端静态检查（假 DOM 里跑主脚本）
node scripts/check-fav-filter.mjs  # 收藏夹清洗规则 32 项
node scripts/heart-preview.mjs --count=30   # 心动模式无头预演，出 30 首报告
```

---

## 不要提交的东西

`.gitignore` 已经挡住：`.deploy/`（服务器私钥）、`data/`（线上数据）、`backups/`、`app/android/app/hnmusic.jks`。
**B站 cookie、SESSDATA 一律不进仓库。**

---

## 现有功能一览

- 搜索 / 播放（B站 音源，服务端代理取流）/ 音质选择
- 歌单、收藏夹同步（每天 6 点增量刷新最新 15 首）
- 心动模式（见上）
- 一起听（房间 + SSE + 队列 + 心跳）
- 游客模式、邀请码注册、管理员后台
- 每日精选、为你推荐、按分区/标签浏览
- 锁屏控制（`navigator.mediaSession`）
