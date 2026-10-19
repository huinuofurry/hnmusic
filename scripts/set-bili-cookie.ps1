# Put the Bilibili throwaway-account cookie on the server (read-only use).
#
# Usage (run from the hnmusic folder on your PC):
#   1) Open Edge/Chrome, log in to bilibili.com with the THROWAWAY account.
#   2) F12 -> Application -> Cookies -> https://www.bilibili.com
#      Copy the values of SESSDATA and (if present) buvid3.
#   3) Save them into a text file, exactly like:
#        SESSDATA=xxxxxxxxxxxx; buvid3=yyyyyyyy
#      e.g.  F:\hnmusic\.bili-cookie.txt   (git-ignored, never part of the zip)
#   4) powershell -ExecutionPolicy Bypass -File scripts\set-bili-cookie.ps1
#
# What it does:
#   - uploads the cookie to the server and stores it as /etc/hnmusic.env
#     (mode 600, root only: the app's own user cannot read it)
#   - installs a systemd drop-in so the service loads that file
#   - restarts the service and prints whether the personalised feed worked
# The cookie is never printed by this script and never sent to the browser.
#
# To remove it again: run with -Remove
param(
    [string]$CookieFile = (Join-Path $PSScriptRoot '..\.bili-cookie.txt'),
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Key = Join-Path $PSScriptRoot '..\.deploy\id_ed25519'
$Srv = 'ubuntu@124.220.169.253'

function Remote([string]$cmd) {
    & ssh -i $Key -o BatchMode=yes $Srv $cmd
    if ($LASTEXITCODE -ne 0) { throw "remote command failed: $cmd" }
}

if ($Remove) {
    Write-Host '[1/3] removing /etc/hnmusic.env ...'
    Remote 'sudo rm -f /etc/hnmusic.env && echo removed'
    Write-Host '[2/3] restarting ...'
    Remote 'sudo systemctl restart hnmusic && sleep 2 && systemctl is-active hnmusic'
    Write-Host '[3/3] done. Personalised feed is OFF again (anonymous recommendations).'
    exit 0
}

if (-not (Test-Path $CookieFile)) {
    Write-Host "Cookie file not found: $CookieFile"
    Write-Host 'Create it first (one line: SESSDATA=xxx; buvid3=yyy).'
    exit 1
}
$raw = (Get-Content -Raw -Path $CookieFile).Trim()
if ($raw.Length -lt 20 -or $raw -notmatch 'SESSDATA=') {
    Write-Host 'That file does not look like a bilibili cookie (need SESSDATA=...).'
    exit 1
}

# Ask bilibili "who is this cookie" BEFORE installing anything.
# IMPORTANT: the check runs ON THE SERVER (not on this PC).
#   A bilibili session seen from two different IPs (your home + the server) is a
#   classic reason for their risk control to kill the session. So: upload first,
#   verify on the server, and from then on only the server touches it.
# (2026/10/17: two pasted cookies died this way - the mechanism was fine, the
#  session was gone.)
$tmpRemote = '/tmp/.hnc'
& scp -i $Key -o BatchMode=yes $CookieFile "${Srv}:$tmpRemote" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }

Write-Host '[0/4] checking which account this cookie belongs to (on the server) ...'
Remote "cd /opt/hnmusic && node scripts/check-bili-cookie.mjs $tmpRemote"
$answer = Read-Host 'Is that the THROWAWAY account? (y/N)'
if ($answer -notmatch '^(y|Y|yes)$') {
    Remote "rm -f $tmpRemote"
    Write-Host 'Aborted. Nothing was uploaded permanently or changed.'
    exit 1
}

Write-Host '[1/4] installing /etc/hnmusic.env (600, root) + systemd drop-in ...'
Remote 'sudo bash -c ''printf "HN_BILI_COOKIE=%s\n" "$(tr -d "\r\n" < /tmp/.hnc)" > /etc/hnmusic.env && chmod 600 /etc/hnmusic.env && chown root:root /etc/hnmusic.env && rm -f /tmp/.hnc && mkdir -p /etc/systemd/system/hnmusic.service.d && printf "[Service]\nEnvironmentFile=-/etc/hnmusic.env\n" > /etc/systemd/system/hnmusic.service.d/cookie.conf && systemctl daemon-reload && echo installed'''

Write-Host '[3/4] restarting the service ...'
Remote 'sudo systemctl restart hnmusic && sleep 3 && systemctl is-active hnmusic'

Write-Host '[4/4] checking the log (did the personalised feed work?) ...'
Start-Sleep -Seconds 2
Remote 'sudo journalctl -u hnmusic --since "90 seconds ago" --no-pager | grep -i "bili" | tail -5 || echo "(no bili log lines yet - open the site and play a song)"'

Write-Host ''
Write-Host 'Done. Open the site and press Ctrl+F5; the related list should start showing niche picks.'
Write-Host 'To turn it off later:  powershell -ExecutionPolicy Bypass -File scripts\set-bili-cookie.ps1 -Remove'
