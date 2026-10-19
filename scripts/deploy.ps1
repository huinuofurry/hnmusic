<#
  一条命令上线：传文件 -> 备份 -> 覆盖 -> 重启 -> 交给 check-live 核对。

  !! 这个文件必须存成 UTF-8 带 BOM !!
     这台机器上是 Windows PowerShell 5.1，它读 .ps1 时如果没 BOM 就按 GBK 解，
     中文会变乱码、连字符串引号都被搞坏、整个脚本报一堆语法错（2026/10/15 踩过）。
     用编辑器改完确认 BOM 还在：
       $t=[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)
       [IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding $true))

  用法（在项目根目录）：
      powershell -NoProfile -File scripts\deploy.ps1 src/rooms.js public/index.html
      powershell -NoProfile -File scripts\deploy.ps1 -All          # src/ 和 public/ 全传
      ... -Yes        有人在房间里也照样重启（默认会停下来问）
      ... -NoVerify   跳过最后的 check-live

  另外：这里是 PowerShell **5.1**（没有 pwsh 7），
  所以脚本里不许用 && 、?? 、三元这些 7.x 才有的东西。

  前置：本机有部署密钥 .deploy/id_ed25519，且它的公钥已在服务器
  ~/.ssh/authorized_keys 里（换机器时重建一次即可）。

  安全设计（每条都是从踩过的坑来的）：
    * 先备份 /opt/hnmusic
    * 重启前查在线人数，有人在就停下来（重启会清空房间）
    * 覆盖后逐个确认文件到位（新文件漏传过：track.js 漏了服务起不来）
    * 不碰 data/（线上那份数据是唯一的）
    * 重启后 curl health，再跑 scripts/check-live.mjs 核对
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Files,
    [switch]$All,
    [switch]$Yes,
    [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$key = $env:HN_KEY
if (-not $key) { $key = Join-Path $root '.deploy\id_ed25519' }
$sshHost = $env:HN_HOST
if (-not $sshHost) { $sshHost = 'ubuntu@124.220.169.253' }
$srv = $env:HN_SRV
if (-not $srv) { $srv = 'http://124.220.169.253:8443' }

if (-not (Test-Path $key)) { throw "找不到部署密钥: $key" }

# ---------- 挑出要传的文件 ----------
if ($All) {
    $Files = @()
    foreach ($d in @('src', 'public')) {
        Get-ChildItem (Join-Path $root $d) -File | ForEach-Object { $Files += ($d + '/' + $_.Name) }
    }
}
if (-not $Files -or $Files.Count -eq 0) {
    Write-Host '没说改哪些文件。' -ForegroundColor Yellow
    Write-Host '  powershell -NoProfile -File scripts\deploy.ps1 src/rooms.js public/index.html' -ForegroundColor Yellow
    Write-Host '  或者 -All 把 src/ 和 public/ 全传一遍' -ForegroundColor Yellow
    exit 2
}
$clean = @()
foreach ($f in $Files) {
    $f = $f.Replace('\', '/').TrimStart('./')
    if ($f -like 'data/*') { throw "不许传 data/（线上那份数据是唯一的）: $f" }
    if (-not (Test-Path (Join-Path $root ($f -replace '/', '\')))) { throw "本地没有这个文件: $f" }
    $clean += $f
}
$Files = $clean
$jsFiles = @($Files | Where-Object { $_ -like '*.js' })
$otherFiles = @($Files | Where-Object { $_ -notlike '*.js' })
# 只有改了 src/ 下的 .js 才需要重启。public/index.html 是每次请求现读磁盘的，
# 不重启也生效（用户 Ctrl+F5 就行）—— 而重启会清空所有房间，能省则省。
$needRestart = ($jsFiles.Count -gt 0)
Write-Host ('要传 ' + $Files.Count + ' 个文件: ' + ($Files -join ', ')) -ForegroundColor Cyan
if ($needRestart) { Write-Host '  改了 src/ → 需要重启（会清空房间）' -ForegroundColor Yellow }
else { Write-Host '  只改前端 → 不重启，让用户 Ctrl+F5 即可' -ForegroundColor Green }

# ---------- ① 要重启的话，先看有没有人在房间里 ----------
Write-Host ''
if ($needRestart) { Write-Host '[1/5] 检查线上有没有人在听...' -ForegroundColor Cyan }
else { Write-Host '[1/5] 不用重启，跳过在线检查' -ForegroundColor Cyan }
$busy = $false
$adminUser = $env:HN_ADMIN_USER
if (-not $adminUser) { $adminUser = 'huinuo' }
$adminPass = $env:HN_ADMIN_PASS
if (-not $adminPass) { $adminPass = '258015124' }
if ($needRestart) {
try {
    $body = @{ username = $adminUser; password = $adminPass } | ConvertTo-Json
    $login = Invoke-RestMethod -Uri ($srv + '/api/auth/login') -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15
    $hdr = @{ Authorization = 'Bearer ' + $login.token }
    # 先算出"我自己是谁"。规则（用户 2026/10/16 明确要求）：
    #   "如果服务器里面有不止我一个人要重启的话提醒我一下，
    #    只有我一个人可以直接重启，有其他人的话会有点尴尬"
    # ⇒ 在线的人里只要**除了我还有别人**就停下来问；
    #   只有我自己（或者根本没人）就直接重启。
    $myKey = ''
    try {
        $meInfo = Invoke-RestMethod -Uri ($srv + '/api/auth/me') -Headers $hdr -TimeoutSec 15
        if ($meInfo.user -and $meInfo.user.id) { $myKey = 'u:' + $meInfo.user.id }
        elseif ($meInfo.session -and $meInfo.session.sid) { $myKey = 's:' + $meInfo.session.sid }
    } catch {
        # 认不出自己就当"谁都不认识" —— 下面会保守地把所有人都当别人，宁可多问一句
        Write-Host '      （算不出自己是哪个身份，下面按保守处理）' -ForegroundColor DarkGray
    }
    $others = @()
    $rl = Invoke-RestMethod -Uri ($srv + '/api/rooms') -Headers $hdr -TimeoutSec 15
    foreach ($r in $rl.rooms) {
        $d = Invoke-RestMethod -Uri ($srv + '/api/rooms/' + $r.roomId) -Headers $hdr -TimeoutSec 15
        foreach ($m in @($d.members | Where-Object { -not $_.offline })) {
            if (-not $myKey -or $m.key -ne $myKey) { $others += ($m.name + '（在「' + $r.name + '」）') }
        }
    }
    if ($others.Count -eq 0) {
        Write-Host '      除了你没有别人在线，直接重启' -ForegroundColor Green
    } else {
        Write-Host ('      ⚠️ 除了你，还有 ' + $others.Count + ' 个人在线：') -ForegroundColor Yellow
        foreach ($o in $others) { Write-Host ('        · ' + $o) -ForegroundColor Yellow }
        $busy = $true
    }
} catch {
    Write-Host ('      查不了（' + $_.Exception.Message + '），继续') -ForegroundColor Yellow
}
}   # end if ($needRestart)
if ($busy -and -not $Yes) {
    Write-Host ''
    Write-Host '⚠️  有**别人**在听 —— 重启会把所有人踢出去、房间也清空。' -ForegroundColor Yellow
    Write-Host '   这一步等你点头，我不擅自动手：' -ForegroundColor Yellow
    Write-Host ('     · 现在就更新（会踢人）：加 -Yes  →  -File scripts\deploy.ps1 ' + ($Files -join ' ') + ' -Yes') -ForegroundColor Yellow
    Write-Host '     · 或者等大家听完再更新' -ForegroundColor Yellow
    exit 3
}

# ---------- ② 传上去 ----------
Write-Host ''
Write-Host '[2/5] scp 到 /tmp ...' -ForegroundColor Cyan
$localPaths = @()
foreach ($f in $Files) { $localPaths += (Join-Path $root ($f -replace '/', '\')) }
$scpArgs = @('-i', $key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes') + $localPaths + @(($sshHost + ':/tmp/'))
& scp @scpArgs
if ($LASTEXITCODE -ne 0) { throw ('scp 失败（exit ' + $LASTEXITCODE + '）') }

# ---------- ③ 服务器上：备份 -> 覆盖 -> chown -> 确认 -> 重启 ----------
Write-Host ''
Write-Host '[3/5] 备份 + 覆盖 + 重启...' -ForegroundColor Cyan
$stamp = Get-Date -Format 'MMdd-HHmmss'

$lines = @()
$lines += 'set -e'
$lines += '[ -d /opt/hnmusic ] || { echo NO_APP_DIR; exit 8; }'
$lines += ('sudo cp -r /opt/hnmusic /opt/hnmusic.bak.' + $stamp)
if ($jsFiles.Count -gt 0) {
    $names = @()
    foreach ($f in $jsFiles) { $names += ('/tmp/' + (Split-Path $f -Leaf)) }
    $lines += ('sudo cp ' + ($names -join ' ') + ' /opt/hnmusic/src/')
}
$byDir = @{}
foreach ($f in $otherFiles) {
    $d = Split-Path $f -Parent
    if (-not $byDir.ContainsKey($d)) { $byDir[$d] = @() }
    $byDir[$d] += ('/tmp/' + (Split-Path $f -Leaf))
}
foreach ($d in $byDir.Keys) {
    $lines += ('sudo cp ' + ($byDir[$d] -join ' ') + ' /opt/hnmusic/' + $d + '/')
}
$lines += 'sudo chown -R hnmusic:hnmusic /opt/hnmusic/src /opt/hnmusic/public'
foreach ($f in $Files) {
    $lines += ('test -f /opt/hnmusic/' + $f + ' || { echo MISSING:' + $f + '; exit 9; }')
}
$lines += 'echo FILES_OK'
if ($needRestart) {
    $lines += 'sudo systemctl restart hnmusic'
    $lines += 'sleep 2'
    $lines += 'systemctl is-active hnmusic'
} else {
    $lines += 'echo SKIP_RESTART'
}
$lines += 'curl -s --max-time 10 localhost:8080/api/health'
$lines += 'echo'
$lines += ('echo BACKUP=/opt/hnmusic.bak.' + $stamp)
$remote = ($lines -join "`n")

$out = & ssh -i $key -o BatchMode=yes -o IdentitiesOnly=yes $sshHost $remote 2>&1
foreach ($l in $out) { Write-Host ('      ' + $l) }
$joined = ($out -join "`n")
if ($joined -match 'MISSING:') { throw '有文件没到位（见上），服务可能起不来' }
if ($joined -match 'NO_APP_DIR') { throw '服务器上没有 /opt/hnmusic' }
$backup = ''
foreach ($l in $out) { if ($l -match '^BACKUP=') { $backup = ($l -replace '^BACKUP=', '') } }

# ---------- ④ health ----------
Write-Host ''
Write-Host '[4/5] 健康检查...' -ForegroundColor Cyan
$healthy = $false
try {
    $h = Invoke-RestMethod -Uri ($srv + '/api/health') -TimeoutSec 15
    if ($h.ok) { $healthy = $true }
    Write-Host ('      /api/health -> ' + ($h | ConvertTo-Json -Compress)) -ForegroundColor Green
} catch {
    Write-Host ('      health 不通：' + $_.Exception.Message) -ForegroundColor Red
}
if (-not $healthy) {
    Write-Host '      回滚命令：' -ForegroundColor Yellow
    Write-Host '        sudo systemctl stop hnmusic' -ForegroundColor Yellow
    Write-Host '        sudo rm -rf /opt/hnmusic/src /opt/hnmusic/public' -ForegroundColor Yellow
    Write-Host ('        sudo cp -r ' + $backup + '/src /opt/hnmusic/ && sudo cp -r ' + $backup + '/public /opt/hnmusic/') -ForegroundColor Yellow
    Write-Host '        sudo chown -R hnmusic:hnmusic /opt/hnmusic && sudo systemctl start hnmusic' -ForegroundColor Yellow
    exit 4
}

# ---------- ⑤ 核对 ----------
if (-not $NoVerify) {
    Write-Host ''
    Write-Host '[5/5] 核对线上状态（scripts/check-live.mjs）...' -ForegroundColor Cyan
    & node (Join-Path $PSScriptRoot 'check-live.mjs')
}

Write-Host ''
Write-Host ('上线完成。备份在 ' + $backup) -ForegroundColor Green
if ($Files -contains 'public/index.html') { Write-Host '注意：改了前端，让朋友 Ctrl+F5' -ForegroundColor Yellow }
