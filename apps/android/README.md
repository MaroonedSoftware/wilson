# Wilson for Android

The operator's board in a pocket: sign in, watch the board live, act on cards, plan and chat, and get
a push notification when a card needs you. Hosts, settings, API keys, factor enrolment and stage
config stay on the web app and the CLI.

Built the way `apps/android` in deadair is: Kotlin, Compose, Navigation 3 and Ktor, over the client
generated into `packages/sdk-kotlin`. Logic stays free of `android.*` so plain JVM tests cover it.

```bash
cd apps/android && ./gradlew :sdk:build :app:assembleDebug :app:testDebugUnitTest :app:lintDebug :app:bundleRelease
```

This needs JDK 21 and an Android SDK with platform 37.2, named by `sdk.dir` in a `local.properties`
that is not committed. Changing a contract means running `pnpm codegen` from the repo root; never edit
`packages/sdk-kotlin/src`.

## Things that are not obvious

- **A refresh is single-flight.** Refresh tokens are single-use and replaying one revokes the family,
  so `SessionManager.refreshed` re-checks the token inside its lock.
- **Only the API's own refusal ends a session**: a 401 naming `invalid_grant`, `invalid_token` or
  `invalid_request`. A 429, a 5xx or a proxy's answer leaves it alone.
- **A lost merge answer means unknown.** A merge runs the suite first; the app re-reads the card and
  never retries.
- **Streams are hand-written** (`auth/LiveStream.kt`), since the event routes are not in the contracts.
  The plan stream sends `turn` only on connecting and `delta` live, and chat replays nothing.
- **Debug builds allow http**, for an emulator reaching a local API at `http://10.0.2.2:13100`. Release
  builds are https only.

## Turning on push

Push is off until both halves are set up, and the app builds and runs without either.

1. Create a Firebase project and add an Android app with the id `com.maroonedsoftware.wilson`.
2. Save its `google-services.json` as `apps/android/app/google-services.json`. It is gitignored, and
   the build applies the Google services plugin only when it is there.
3. Create a service-account key and put the file on the server under `/data/secrets`.
4. Set `FCM_SERVICE_ACCOUNT_FILE` to that path (`PROJECT.md`, Reaching it from a public host).

A message carries ids only. The app fetches the card's title itself, and falls back to "Card 0123
needs you" when it cannot.

## Not yet here

Passkeys need Credential Manager, an `assetlinks.json` on the public host, and a change to how the API
accepts origins. Until then a passkey-only account must also set up an authenticator app. Card text
is shown plain, not as rendered Markdown, and the copy lives in the screens rather than `strings.xml`.
