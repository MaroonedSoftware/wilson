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

## Sign-in

The screen is deadair's setup steps: a welcome on a first run, the address, then the sign-in and any
code. A remembered server opens on the sign-in. `ServerProbe` asks `/api/health` before an address is
kept, and an address that answers moves straight on, because a server has no name to confirm.

## Packaging

`tools/macos/make-app-bundle.sh` builds `artifacts/Wilson.app`, signed ad hoc under the hardened
runtime. `.github/workflows/desktop-release.yml` publishes a `desktop-v<version>` release when a push
to main changes `Version` in `Directory.Build.props`, so **bumping the version is the decision to
ship**: nobody looks at it after that, and installed copies offer it within six hours. The tests cover
Core and not the screens, so walk the app before bumping, and a bad release can only be replaced by
a higher version. Run by hand, the workflow makes a draft. It skips a version that already has a
release, draft or not. It is not notarised, so macOS refuses a first launch. `tools/macos/make-app-icon.sh` rebuilds the committed `.icns` from `brand/`.

## Updates

The app checks GitHub at launch and every six hours, using its own `HttpClient` so the operator's
token never reaches GitHub. It downloads a newer `desktop-v*` release in the background, and installs
it only on "Restart to update", so a planning turn or a merge is never cut off.

- **Nothing vouches for an update but `UpdateSignature`.** The app is not notarised, and a file it
  downloads itself is not quarantined, so Gatekeeper never looks. The workflow signs
  `wilson-update <version> <sha256>` with ECDSA P-256 (.NET has no Ed25519). The version is signed so
  an old zip cannot pass as a newer release. `UpdateSignature.Message` and the workflow must agree.
- **The key is one-way.** `tools/macos/make-update-key.sh` puts the private half in the
  `UPDATE_SIGNING_KEY` secret and writes `Updates/update-key.pem`. A new key strands every installed
  copy, which would refuse updates until installed by hand, so never replace it casually. A build
  without the file only gives notice, and the release workflow refuses to run without it.
- **A swap cannot leave no app.** `BundleSwap.Script` waits for the exit, restores the old bundle if
  the swap fails, and relaunches either way. Staging sits beside the bundle because `mv` is atomic
  only within a volume. An app the person cannot write beside falls back to the notice.
- To change the swap, run it on real bundles: `make-app-bundle.sh <version>` takes a version, and
  `tools/Walk -- update` installs a signed zip over a bundle. It relaunches that bundle.

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
card's plan shows as plain text, not rendered Markdown. There is no menu-bar icon or notification,
and closing the window quits.

## Verified

2026-11-01, against the throwaway API with `tools/Walk`: sign-in and its refusals, the board live from
the feed, creating and editing a card, moving one, a merge refused by the server, opening a planning
session, saving a draft (refused by the server's own check), comments, a real planning turn, a real
chat turn, chat as the home page opening the latest thread and surviving a trip to the board, and a
diff of a real branch (that diff step was not repeated after chat became the home page). The Keychain
round trip passed on a real Keychain, and `Wilson.app` launched and opened its window. The first
release built, signed and published from the workflow, and that download launched from `/Applications`.

2026-11-01, updates: a real 0.0.1 bundle updated to a real 0.0.2 signed by `openssl` as the workflow
does, relaunched with its window and passed `codesign --strict`. A tampered zip and a version the
signature did not name were both refused.

Not verified:

- A real authenticator code through the code step, which the walk only poses: the seeded operator has none.
- An update through the running app's own button, or from a real release.
- Typing into the real window, as opposed to driving the view models headless, and a session
  surviving a relaunch of the real app.
- The app against Tower or the real board.
- A confirmed chat action, an acknowledged flag, a successful merge, and a token refresh or reconnect
  against a real server: the seeded board offers none, and the last two are proved against `FakeServer`.
- Whether streamed text appears as it arrives: the walk saw the finished turns, not the deltas.
- Either GitHub workflow.
