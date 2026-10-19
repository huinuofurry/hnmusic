#!/bin/bash
# 测国内镜像可达性
for u in \
  "https://mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip" \
  "https://maven.aliyun.com/repository/google/" \
  "https://maven.aliyun.com/repository/public/" \
  "https://mirrors.cloud.tencent.com/gradle/" \
  "https://services.gradle.org/distributions/gradle-8.7-bin.zip" \
  "https://maven.google.com/"
do
  code=$(timeout 12 curl -s -o /dev/null -w '%{http_code} %{size_download}' -r 0-1000000 "$u" 2>/dev/null || echo "TIMEOUT")
  echo "$code  <- $u"
done
