# The Android app

The operator's board in a pocket. `apps/android/README.md` says what it is and how to build it; this
is what you need to change it safely. It follows deadair's `apps/android`, and its `CLAUDE.md` is the
place to look for anything not covered here.

```bash
cd apps/android && ./gradlew :sdk:build :app:assembleDebug :app:testDebugUnitTest :app:lintDebug :app:bundleRelease
```

**Tests passing does not mean the app works.** JVM tests cover the logic and nothing else. After
changing a screen, navigation or anything that talks to the server, run it with the `android-verify`
skill, and say plainly what you did not run. Record what you find here, dated.

## The toolchain

- JDK 21 at `/opt/homebrew/opt/openjdk@21`: there is no system Java. `sdk.dir` goes in `local.properties`.
- `compileSdk` is 37 with minor 2 because AndroidX refuses less. AGP's built-in Kotlin rules out the
  `kotlin.android` plugin, and `:sdk` applies its Kotlin plugins with no version. Both are deadair's facts.
- In the sandbox, `adb` and the emulator work, but `./gradlew` needs help: Java ignores `HTTPS_PROXY`, and
  `~/.gradle`, `~/.android` and the JVM's temp folder are not writable. `.claude/settings.json` excluding
  `./gradlew *` and `apps/android/tools/*` from the sandbox is the fix, and only you can add that file;
  `verify.sh up` needs it. Writes to `.idea` paths are denied too, which breaks a fresh `pnpm install`
  inside the sandbox because `iconv-lite` ships one.
- A migration's timestamp must be unused on every branch, not just this one: dbmate skips a version
  already recorded in the shared test database, so a clash silently loses the table.

## What the API does to a client

- `/api/feed` replays a snapshot on connecting and never what was missed, so reconnecting reloads.
- The plan stream sends `turn` only on connecting and `delta` live, and the POST answers with the reply
  alone. The person's own turn is therefore put together locally (`withReply`).
- Chat replays nothing: read the thread, then listen. Any reconnect reads the thread again.
- A merge runs the suite before answering, so it takes the long client, and a lost answer is unknown.
- `POST /api/devices` needs `wilson.manage`, as every write does.

## Found on the emulator

- 2026-10-31, API 36: a screen does not re-run `init` when navigated back to, and `/api/feed` reports
  nothing about what happened meanwhile, so both the board and card detail showed stale data after
  creating or editing a card. Each now reads afresh every time it starts following the feed.
- 2026-10-31: a first boot takes several minutes under `swiftshader_indirect`, and `adb devices` can
  show nothing until the daemon restarts. `adb kill-server` before deciding the emulator failed.
- 2026-10-31: a fresh database has no `planning` stage, so opening a plan there answers 500 with
  `no stage named "planning"`. That is the seed data, not the app. Planning is not yet exercised.
- 2026-10-31: creating a card publishes no feed event, so a card made elsewhere reaches an open board
  only on its next reload. Moves arrive in about two seconds. The web app has the same gap.
- 2026-10-31: the feed's response headers can wait for its first write, up to the 15 second heartbeat,
  so the board can read `reconnecting` that long on a quiet board with nothing wrong.
