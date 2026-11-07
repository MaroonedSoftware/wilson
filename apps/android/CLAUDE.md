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
- The emulator does not boot inside the sandbox: it stalls after three log lines, with no error. Started
  outside it boots in about 20 seconds, and `adb` inside the sandbox can then drive it. `./gradlew` needs
  help too: Java ignores `HTTPS_PROXY`, and `~/.gradle`, `~/.android` and the JVM's temp folder are not
  writable. `.claude/settings.json` excluding `./gradlew *` and `apps/android/tools/*` from the sandbox is
  the fix, and a person has to add that file. Writes to `.idea` paths are denied too, which breaks a fresh `pnpm install`
  inside the sandbox because `iconv-lite` ships one.
- A migration's timestamp must be unused on every branch, not just this one: dbmate skips a version
  already recorded in the shared test database, so a clash silently loses the table.

## What the API does to a client

- `/api/feed` replays a snapshot on connecting and never what was missed, so reconnecting reloads.
- The plan stream sends `turn` only on connecting and `delta` live, and the POST answers with the reply
  alone. The person's own turn is therefore put together locally (`withReply`).
- Chat replays nothing: read the thread, then listen. Any reconnect reads the thread again. An `asked` event,
  like `proposed`, only says a question was stored, so it reads the thread again too.
- A merge runs the suite before answering, so it takes the long client, and a lost answer is unknown.
- `POST /api/devices` needs `wilson.manage`, as every write does.
- 2026-11-07: a chat image (`GET /api/chat/threads/{id}/attachments/{attachmentId}`) needs the bearer like any
  route, so the chat fetches it through `SessionManager.call` (`fetchChatImage`) and never with an image
  library's own HTTP stack, which would miss the single-flight refresh. The bytes never change for an id, so
  `ChatImages` keeps each image, or its failure, for the life of the chat screen, as web does. The route may
  answer `image/svg+xml`, which `BitmapFactory` cannot read: such an image shows as failed. Images are decoded
  at most 2048 px on a side. Answers' images are drawn under the text, as Android has no Markdown renderer to
  place the ones an answer embeds.

## Found on the emulator

- 2026-11-04, API 36: after "Use a different server" and signing in, the board still calls the old address
  (`Failed to connect to /10.0.2.2:13150`) until the app is killed and reopened.
- 2026-10-31, API 36: a screen does not re-run `init` when navigated back to, and `/api/feed` reports
  nothing about what happened meanwhile, so both the board and card detail showed stale data after
  creating or editing a card. Each now reads afresh every time it starts following the feed.
- 2026-10-31: an `emulator-5554` in `adb devices` is not necessarily ours. An early run drove the person's
  `deadair` emulator by mistake and `adb emu kill` shut it down. Always read `ro.boot.qemu.avd_name`
  first; `verify.sh` now refuses anything but `wilson`.
- 2026-10-31: a fresh database has no `planning` stage, so opening a plan answers 500, and the project root
  must be a git repository. With both in place, opening a session, the draft, comments and closing all
  worked. The app shows refusals as a snackbar, now held long enough to read a full sentence.
- 2026-10-31: creating a card publishes no feed event, so a card made elsewhere reaches an open board
  only on its next reload. Moves arrive in about two seconds. The web app has the same gap.
- 2026-10-31: the feed's response headers can wait for its first write, up to the 15 second heartbeat,
  so the board can read `reconnecting` that long on a quiet board with nothing wrong.
- 2026-11-01: an address field needs `autoCorrectEnabled = false` as well as `KeyboardType.Uri`, or the
  keyboard treats it as prose and adds a space after each dot. Check with `dumpsys input_method`: the
  address field reads `inputType=0x11`, with no `0x8000` autocorrect flag.
- 2026-11-04: `.claude/settings.json` still does not exist, so `./gradlew` has no sandbox exclusion. Gradle does
  work inside the sandbox with `GRADLE_USER_HOME`, `ANDROID_USER_HOME` and `java.io.tmpdir` under `$TMPDIR`, and
  the proxy's host, port and login as `systemProp`s in that home's `gradle.properties` (Java answers 407 without
  the login, and needs `jdk.http.auth.tunneling.disabledSchemes=` empty). A build made that way is signed with a
  different debug key, so `adb install -r` refuses it over the usual build: uninstall first, and again when done.
- 2026-11-04: chat cannot propose a change without engine credentials, so check the proposal card by inserting
  rows into `wilson.chat_threads` and `wilson.chat_pending_actions` in `wilson_android`. Swipes in the list's
  side padding do nothing: it sits outside the scroller. A long value's box scrolls first, then hands the
  gesture on to the list, so Confirm is reachable even in landscape, where the box is taller than the list.
- 2026-11-04: a confirmed action that failed used to leave the screen showing nothing, because only awaiting
  actions were drawn. Every action now stays on its card with how it went, and an action follows the answer of
  the turn that proposed it: it is stored mid-turn and the answer at the end, so sorting by time, as web does,
  puts it above that answer. A real turn stored them 2.6 seconds apart in that order.
- 2026-11-04: the local API can reach a real engine. Started with `preview_start` outside the sandbox it uses the
  machine's Claude login, so confirming a seeded action starts a real follow-up turn that can answer and propose
  another change a few seconds later. Read the screen again before tapping a position you found earlier. The
  turn spends real usage, though what it proposes only runs if confirmed.
- 2026-11-04: `verify.sh ui` leaves out any text containing a double quote, because the dump writes that attribute
  in single quotes. A screenshot showed the failed action's error while `ui` did not list it.
- 2026-11-07: a card's pull request (open or merged) shows in Merge's place and opens in the browser; a closed one
  shows Merge again. Seen on screen by setting `pull_request` on `ready` cards in `wilson_android`, with the two
  pull request events inserted by hand. "Opened pull request #n" needs GitHub, so it is proved in `MergeOutcomeTest`
  only. Nothing scopes a view model to a navigation entry, so every screen's sat in the activity's store and
  outlived signing out: the board kept the projects, or the error, of the session before. The signed-in screens'
  models are now in `SessionScope`, emptied when the session ends. `verify.sh seed` fails with `KeyError: 'accessToken'` when the throwaway account has an active
  authenticator left over from a desktop security walk; set `active = false` on it. With a second emulator
  attached, `export ANDROID_SERIAL=<wilson's serial>` before `verify.sh`.
- 2026-11-07, not yet run on a screen: the stats screen (`ui/stats`) reads `/api/stats` and `/api/stats/gates`
  together for one window, because the pass rate subtracts the gates' revises, as web's does. A read for a window
  no longer chosen is dropped, and the previous figures stay up while a new window loads. It re-reads each time it
  starts and on each non-tool feed event. The stage that built it could not run `./gradlew` or the emulator: check
  it on `wilson`, rotating it, and check that the board's top bar still fits with four buttons on a narrow phone.
- 2026-11-06, not run on a screen: chat questions (`ask_user`) are stored mid-turn like proposed actions, so a
  question card follows the answer of the turn that asked it, by the same rule. A refused answer is the chat's
  first snackbar; a refused Confirm or Decline still shows as the red line above the composer. Android is not a
  changesets package, so its changesets carry no package and release nothing. To check the card, insert a row
  into `wilson.chat_questions` in `wilson_android` as for actions.
- 2026-11-04: the notification prompt comes back each time the activity is recreated, rotation included, until it
  is refused twice, because `AskForPush` asks from a `LaunchedEffect`. It covers the screen, so dismiss it first.
