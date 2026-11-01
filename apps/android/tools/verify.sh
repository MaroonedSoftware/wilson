#!/usr/bin/env bash
# Drives the Android app on an emulator. See .claude/skills/android-verify/SKILL.md.
#   boot        start the wilson emulator; run this outside the sandbox, where it can boot
#   up          build, install, seed the local API and launch
#   seed        create the test account and cards on the local API
#   shot NAME   screenshot to $SHOTS/NAME.png
#   ui          list on-screen elements with the centre to tap
#   log         this app's recent errors and crashes
#   down        stop the emulator
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
AVD="${WILSON_AVD:-wilson}"
IMAGE="system-images;android-36;google_apis;arm64-v8a"
APP=com.maroonedsoftware.wilson
API="http://localhost:${ANDROID_API_PORT:-13150}"
EMAIL=operator@example.com
PASSWORD='correct horse battery staple 47'
SHOTS="${SHOTS:-${TMPDIR:-/tmp}/wilson-android-shots}"

# The AVD on the attached emulator, empty when there is none.
attached() {
    adb devices | grep -q '^emulator-.*device$' || return 0
    adb shell getprop ro.boot.qemu.avd_name </dev/null | tr -d '\r'
}

# Any other emulator is the person's own, so nothing here may install on it or stop it.
require_ours() {
    local name
    name="$(attached)"
    if [ "$name" != "$AVD" ]; then
        echo "expected the $AVD emulator, found '${name:-none}': start it with verify.sh boot, and leave any other alone" >&2
        exit 1
    fi
}

boot() {
    if [ "$(attached)" = "$AVD" ]; then return; fi
    avdmanager list avd -c 2>/dev/null | grep -qx "$AVD" || echo no | avdmanager create avd -n "$AVD" -k "$IMAGE" -d pixel_8
    nohup emulator -avd "$AVD" -no-window -no-audio -no-boot-anim -no-snapshot-save >"${TMPDIR:-/tmp}/wilson-emulator.log" 2>&1 &
    echo "waiting for the emulator (log: ${TMPDIR:-/tmp}/wilson-emulator.log)"
    for _ in $(seq 1 60); do
        if [ "$(attached)" = "$AVD" ] && [ "$(adb shell getprop sys.boot_completed 2>/dev/null </dev/null | tr -d '\r')" = 1 ]; then return; fi
        sleep 2
    done
    echo "the emulator did not boot within two minutes" >&2
    exit 1
}

seed() {
    if ! curl -sf -m 3 "$API/api/health" >/dev/null; then
        echo "no API at $API: start apps/android/tools/api.sh first" >&2
        exit 1
    fi
    local body="{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
    curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "$body" "$API/api/onboarding"
    local token
    token="$(curl -s -X POST -H 'content-type: application/json' \
        -d "{\"grant_type\":\"password\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$API/api/auth/token" |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')"
    curl -s -o /dev/null -X POST -H "authorization: Bearer $token" "$API/api/board/init"
    local count
    count="$(curl -s -H "authorization: Bearer $token" "$API/api/cards" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
    if [ "$count" = 0 ]; then
        for title in 'First card' 'Second card'; do
            curl -s -o /dev/null -X POST -H "authorization: Bearer $token" -H 'content-type: application/json' \
                -d "{\"title\":\"$title\",\"body\":\"Seeded by verify.sh\"}" "$API/api/cards"
        done
    fi
}

ui() {
    adb exec-out uiautomator dump /dev/tty 2>/dev/null | python3 -c '
import re, sys
for attrs in re.findall(r"<node ([^>]*?)/?>", sys.stdin.read()):
    get = lambda name: (re.search(name + r"=\"([^\"]*)\"", attrs) or [None, ""])[1]
    label = get("text") or get("content-desc")
    bounds = re.findall(r"\d+", get("bounds"))
    if label and len(bounds) == 4:
        x1, y1, x2, y2 = map(int, bounds)
        print(f"{(x1 + x2) // 2:5} {(y1 + y2) // 2:5}  {label}")
'
}

case "${1:-}" in
    boot) boot ;;
    up)
        require_ours
        seed
        (cd "$ROOT/apps/android" && ./gradlew --console=plain :app:assembleDebug)
        adb install -r "$ROOT/apps/android/app/build/outputs/apk/debug/app-debug.apk"
        adb logcat -c
        adb shell am start -n "$APP/.MainActivity"
        echo "Server: http://10.0.2.2:${ANDROID_API_PORT:-13150}"
        echo "Sign in: $EMAIL / $PASSWORD"
        ;;
    seed) seed ;;
    shot)
        mkdir -p "$SHOTS"
        adb exec-out screencap -p >"$SHOTS/${2:-screen}.png"
        echo "$SHOTS/${2:-screen}.png"
        ;;
    ui) ui ;;
    log) adb logcat -d -t 400 '*:E' | grep -E -A12 "FATAL|$APP" || echo "no errors from $APP" ;;
    down)
        require_ours
        adb emu kill
        ;;
    *)
        sed -n '2,9p' "$0"
        exit 1
        ;;
esac
