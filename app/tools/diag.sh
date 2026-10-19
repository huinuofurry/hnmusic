#!/bin/bash
echo '=== 进程 ==='
ps aux | grep -Ei 'gradle|GradleDaemon|java' | grep -v grep | cut -c1-140 | head -5
echo '=== 磁盘/缓存 ==='
du -sh "$HOME/.gradle" 2>/dev/null
du -sh "$HOME/hnmusic-app/app/build" 2>/dev/null
du -sh "$HOME/gradle-8.7" 2>/dev/null
echo '=== 最近 20 分钟内写过的文件 ==='
find "$HOME/.gradle" "$HOME/hnmusic-app" -newermt '-20 minutes' -type f 2>/dev/null | tail -8
echo '=== 网络：能否访问 maven.google.com / repo.maven ==='
timeout 8 curl -s -o /dev/null -w 'maven.google.com %{http_code} %{time_total}s\n' https://maven.google.com/web/index.html || echo 'maven.google.com 超时'
timeout 8 curl -s -o /dev/null -w 'repo1.maven.org  %{http_code} %{time_total}s\n' https://repo1.maven.org/maven2/ || echo 'repo1 超时'
echo '=== 负载 ==='
uptime
free -m | head -2
