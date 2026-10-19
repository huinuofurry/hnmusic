#!/bin/bash
# 在服务器上装 Android SDK（一次性的）
set -e
cd "$HOME"
mkdir -p android-sdk/cmdline-tools
if [ ! -d android-sdk/cmdline-tools/latest ]; then
  curl -sL -o /tmp/cmdline.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -q -o /tmp/cmdline.zip -d android-sdk/cmdline-tools
  mv android-sdk/cmdline-tools/cmdline-tools android-sdk/cmdline-tools/latest
fi
export ANDROID_HOME="$HOME/android-sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
sdkmanager --sdk_root="$ANDROID_HOME" 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0' >/tmp/sdkinstall.log 2>&1 || tail -5 /tmp/sdkinstall.log
echo "--- 已安装 ---"
ls "$ANDROID_HOME"
du -sh "$ANDROID_HOME"
