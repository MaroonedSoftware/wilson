---
name: android-verify
description: Run the Wilson Android app on an emulator against a local API and check it works on screen. Use when asked to run, test, try or screenshot the Android app, after changing anything in apps/android, or before opening a PR that touches it. Unit tests do not cover screens, navigation or a real server; this does.
---

# Verify the Android app

Read `apps/android/CLAUDE.md` first. Everything below runs from the repo root.

## Start it

1. Start the local API with `preview_start` and the `android-api` config, or run `apps/android/tools/api.sh` in the background. It uses a throwaway database and never touches the real board. Never point this at Tower.
2. `apps/android/tools/verify.sh up` boots the emulator, installs a fresh debug build, seeds the API and launches the app. It prints the server address and test sign-in to use.

If `up` says `node_modules` is missing, run `pnpm install` first. The emulator cannot boot inside the sandbox: it stalls silently after three log lines. Start it outside, in a terminal tab (`apps/android/tools/verify.sh boot`), where it boots in about 20 seconds; `adb` inside the sandbox can then drive it. If `adb devices` stays empty once it is up, run `adb kill-server` and look again.

**Use only the `wilson` AVD.** Check with `adb shell getprop ro.boot.qemu.avd_name` before doing anything. Any other emulator is the person's own: never install on it, change its settings or stop it, even if it is the only one attached. `verify.sh` refuses to. If `./gradlew` fails on the proxy or on `~/.gradle`, `.claude/settings.json` has not loaded or does not exclude it: report that rather than bypassing the sandbox.

## Look and act

| To | Run |
|---|---|
| See the screen | `apps/android/tools/verify.sh shot name`, then Read the PNG it prints |
| Find what to tap | `apps/android/tools/verify.sh ui`, which lists each element's text and centre |
| Tap | `adb shell input tap X Y` |
| Type | `adb shell input text 'value'` (spaces as `%s`) |
| Press back | `adb shell input keyevent KEYCODE_BACK` |
| See a crash | `apps/android/tools/verify.sh log` |

Prefer `ui` over guessing from a screenshot. Screenshot after every step that should change the screen, and check the `log` output before saying a step passed.

## Walk these flows

1. Server address rejected when wrong, accepted at the address `up` printed.
2. Wrong password shows the error; the right one reaches the board.
3. Board shows the seeded cards, the tabs scroll, and the state reads `live`.
4. Open a card; Plan, Activity and Diff all render, including the empty ones.
5. New card appears on the board without a manual refresh.
6. Edit a card, and acknowledge the seeded flag if one is shown. A refusal must appear as a snackbar on that screen.
7. Back works from every screen; rotate the device with `adb shell settings put system user_rotation 1` and confirm nothing is lost.
8. Sign out returns to sign-in, and killing and reopening the app keeps a signed-in session.

Screenshot straight after an action that may be refused: a dump takes a couple of seconds, long enough to miss a snackbar and wrongly conclude nothing happened. Check the API log before calling a button silent.

A fresh database has no `planning` stage, and the project root must be a git repository, so add both before testing planning. With no engine credentials a planning or chat turn answers an auth error, and a successful merge is not reachable. Say what was not exercised. Push needs a Google Play image and a Firebase project and is not covered at all.

## Finish

`apps/android/tools/verify.sh down` stops the emulator. Report what you saw flow by flow, including what you did not run, and attach screenshots of anything wrong. Record anything surprising in `apps/android/CLAUDE.md`, dated, the way deadair's guide does.
