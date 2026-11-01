# The desktop app

Chat with Wilson and the operator's board as a macOS application, in .NET 10 and Avalonia. Chat is the
home page and the board opens from it. It follows deadair's
`apps/desktop`, and that app's `CLAUDE.md` records the measured reason behind most of what is here:
look there first for anything not covered below. Wilson has no audio, so the player and its native
shim have no equivalent. The first release targets Apple Silicon and nothing else.

```bash
cd apps/desktop && dotnet build -warnaserror && dotnet test --solution Wilson.Desktop.slnx
```

## Where it sits

- Not a pnpm workspace member: there is no `package.json`, as in `apps/android`, so turbo and vitest
  ignore it. The `.dockerignore` drops the directory.
- `packages/sdk-csharp` is generated from the contracts. Never hand-edit it except `WilsonSdk.csproj`.
  C# that does not compile is fixed in ContractKit, with a test, and never here.
- `src/...Core` holds everything decidable without a window and must never reference Avalonia.
  `src/...Mac` holds what only macOS can do. Tests are xunit v3 in `tests/`, and cover Core.
- `tests/.../Sdk/DecodeTests` reads the Android tests' recorded API responses. One set, so the two
  clients cannot disagree. Compiling proves nothing about wire names; these do.

## What the API does to a client

Everything in `apps/android/CLAUDE.md` under that heading applies here. Beyond it:

- `/api/auth/token` takes JSON, not deadair's form. Without `x-wilson-cookies: 1` the refresh token is
  in the body, which is what this app wants. It never sends that header.
- A session ends only on a 401 naming `invalid_request`, `invalid_token` or `invalid_grant` in
  `WWW-Authenticate` (`ApiError.RefusesRefresh`), the Android app's rule. Everything else is `Unavailable`.
- Refresh tokens are single-use and a replay revokes the family, so a refresh is single-flight.
- A passkey cannot be answered here. An account with no authenticator gets `SignInResult.PasskeyOnly`.
- The shared `HttpClient` has no timeout: a merge runs the suite before answering, and streams never
  end. So each call that needs a limit brings its own, as the token requests do.

## Looking at it

**Tests passing does not mean the app works.** They cover Core and nothing else. After changing a page,
walk it. `tools/Walk` drives the real view models and views on Avalonia's headless platform with real
Skia drawing, against a real API, and writes a PNG of each step. It changes cards, so point it only
at the throwaway API, never at the real board:

```bash
apps/android/tools/api.sh                     # in the background, serves :13150
apps/android/tools/verify.sh seed
cd apps/desktop && dotnet run --project tools/Walk -- /tmp/walk http://localhost:13150 operator@example.com 'correct horse battery staple 47'
```

Then Read the PNGs. Add a step for what you built, and pass `light` as a fifth argument for the other
appearance. A planning or chat step sends a real turn to the agent, using the machine's Claude login.
The diff step needs a card with a branch: that API's `code_root` is its own scratch repo (see
`wilson.projects`), so make a branch there and set `wilson.cards.branch`.

`dotnet run --project tools/Walk -- keychain` round-trips a throwaway item through the real Keychain.

## Packaging

`tools/macos/make-app-bundle.sh` builds `artifacts/Wilson.app`, signed ad hoc under the hardened
runtime. `.github/workflows/desktop-release.yml` is run by hand and cuts a `desktop-v<version>`
release from `Version` in `Directory.Build.props`. It is not notarised, so macOS refuses a first
launch. `tools/macos/make-app-icon.sh` rebuilds the committed `.icns` from `brand/`.

## Sandbox

- Run `dotnet build` outside it. Avalonia's build-time telemetry task fails there as an `MSB4018`
  with no mention of a sandbox, and a first `dotnet restore` hangs with no error.
- A fresh `pnpm install` hangs too, and `pnpm exec` tries one first, so call
  `apps/api/node_modules/.bin/contractkit` directly.
- macOS has no `timeout` command.

## Against the web app

Here: sign-in, the board and its feed, card detail and every card action, creating and editing,
planning, chat, and the diff. Not here yet, so these still need the web app: onboarding, passkeys,
hosts and settings, the activity and flagged pages (the board's Flagged toggle covers the second),
dragging cards, comments on a diff line (`POST /api/cards/{id}/findings`), and splitting a card. A
card's plan shows as plain text, not rendered Markdown. There is no update check, menu-bar icon or
notification, and closing the window quits.

## Verified

2026-11-01, against the throwaway API with `tools/Walk`: sign-in and its refusals, the board live from
the feed, creating and editing a card, moving one, a merge refused by the server, opening a planning
session, saving a draft (refused by the server's own check), comments, a real planning turn, a real
chat turn, chat as the home page opening the latest thread and surviving a trip to the board, and a
diff of a real branch (that diff step was not repeated after chat became the home page). The Keychain round trip passed on a real Keychain, and
`Wilson.app` launched and opened its window.

Not verified:

- Typing into the real window, as opposed to driving the view models headless, and a session
  surviving a relaunch of the real app.
- The app against Tower or the real board.
- A confirmed chat action, an acknowledged flag, a successful merge, and a token refresh or reconnect
  against a real server: the seeded board offers none, and the last two are proved against `FakeServer`.
- Whether streamed text appears as it arrives: the walk saw the finished turns, not the deltas.
- Either GitHub workflow.
