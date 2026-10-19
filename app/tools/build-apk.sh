#!/bin/bash
# 在服务器上编译 Android APK（WebView 壳）
#   - 首次会下载 Gradle 8.7（~120MB）
#   - keystore 生成一次，之后复用（升级 APK 必须用同一个签名）
set -e
export ANDROID_HOME="$HOME/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(which javac)")")")"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

PROJ="$HOME/hnmusic-app"
cd "$PROJ"

# ① Gradle
if [ ! -x "$HOME/gradle-8.7/bin/gradle" ]; then
    echo "== 下载 Gradle 8.7 =="
    curl -sL -o /tmp/gradle.zip https://services.gradle.org/distributions/gradle-8.7-bin.zip
    unzip -q -o /tmp/gradle.zip -d "$HOME"
fi
GRADLE="$HOME/gradle-8.7/bin/gradle"

# ② keystore（一次）
KS="$PROJ/app/hnmusic.jks"
if [ ! -f "$KS" ]; then
    echo "== 生成签名 keystore =="
    keytool -genkeypair -v \
        -keystore "$KS" -storepass hnmusic2026 -keypass hnmusic2026 \
        -alias hnmusic -keyalg RSA -keysize 2048 -validity 10950 \
        -dname "CN=HnMusic, OU=HN, O=HN, L=Shanghai, ST=Shanghai, C=CN" >/dev/null
fi

# ③ 编译
echo "== gradle assembleRelease =="
"$GRADLE" --no-daemon -q -Dorg.gradle.jvmargs=-Xmx1024m -Dorg.gradle.parallel=false assembleRelease 2>&1 | tail -20

APK="$PROJ/app/build/outputs/apk/release/app-release.apk"
if [ -f "$APK" ]; then
    echo "== 成功 =="
    ls -lh "$APK"
    echo "APK=$APK"
else
    echo "== 失败：没找到产物 =="
    exit 1
fi
