#!/bin/bash
# 看这台机器实际扛了多少（决定"明年续费租多大的"就看这个）。
#
# ⚠️ 用法必须是 **scp 传上去再跑**，别用 `Get-Content | ssh 'bash -s'`：
#    PowerShell 5.1 的管道会用 GBK 编码送出去，中文全变乱码，
#    而且 Windows 的 CRLF 会让 bash 报 `$'\r': command not found` ✗
#    （2026/10/16 第一次就是这么翻车的；下面的 tr -d '\r' 是双保险）
#
#   scp -i .deploy/id_ed25519 scripts/server-usage.sh ubuntu@124.220.169.253:/tmp/
#   ssh -i .deploy/id_ed25519 ubuntu@124.220.169.253 "tr -d '\r' < /tmp/server-usage.sh > /tmp/u.sh && bash /tmp/u.sh"
#
# 看的是：开机以来收发多少、平均/实时上行、现在几个人挂着连接。
#   ⚠️ 这是"开机以来"的数字（计数器重启清零）——
#      **本自然月**的准确用量要去腾讯云控制台看「流量包」那一栏 ✓
set -u

echo "=== 开机时长 ==="
uptime -p
echo "开机于 $(uptime -s)"

echo
echo "=== 网卡累计（eth0）==="
rx=$(cat /sys/class/net/eth0/statistics/rx_bytes)
tx=$(cat /sys/class/net/eth0/statistics/tx_bytes)
sec=$(cut -d. -f1 /proc/uptime)
printf '  收到 %s MB / 发出 %s MB\n' "$((rx / 1048576))" "$((tx / 1048576))"
printf '  平均上行 %s KB/s（开机 %s 小时）\n' "$((tx / sec / 1024))" "$((sec / 3600))"
printf '  按这个速度一个月大约 %s GB（套餐 300GB 的话就是用了 %s%%）\n' \
  "$((tx / sec * 2592000 / 1073741824))" "$((tx / sec * 2592000 / 1073741824 * 100 / 300))"

echo
echo "=== 实时上行（5 秒采样，看现在有没有人在听）==="
p=$(cat /sys/class/net/eth0/statistics/tx_bytes)
for i in 1 2 3 4 5; do
  sleep 1
  n=$(cat /sys/class/net/eth0/statistics/tx_bytes)
  printf '  第 %s 秒 %s KB/s\n' "$i" "$(((n - p) / 1024))"
  p=$n
done

echo
echo "=== 连接 ==="
printf '  总 ESTABLISHED: %s\n' "$(ss -tn state established | wc -l)"
printf '  一起听的 SSE 长连接: %s（每个约等于 1 个在房间里的人）\n' "$(ss -tn state established '( sport = :8080 )' | wc -l)"

echo
echo "=== 换算尺 ==="
echo '  192K 音频 ≈ 24 KB/s/人 ≈ 86 MB/小时/人'
echo '  3 Mbps ≈ 375 KB/s ⇒ 约 15 人同时听；6 Mbps ⇒ 约 30 人'
