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
- A 403 naming `step_up_required` is `lib/session.ts`'s, in `SessionHandler`: it asks `SessionManager.StepUp`,
  which is `StepUpViewModel` over the page, and replays the request with the new session. Cancelling leaves
  it refused. With an authenticator enrolled a password alone does not satisfy it, hence the code step.
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
appearance. `admin` as a sixth walks only hosts, settings and security, which waits out the five minutes a
session must age for a step-up, so a whole walk's end is that wait too. `plan` walks only planning, on a card of its own. `question` walks answering a stage's question, on a board that has one. `images` walks only sending an image in chat. `actions` walks only proposed changes, written to the throwaway database and read back through the API, with no agent turn. `lanes` walks only the lanes page, then waits out those five minutes for a save behind a step-up. `merge` walks only the merge status, and needs a card in `ready`. `goals` walks only the goals list, on goals written to the throwaway database on threads of their own, archived and with wake-ups held so no agent turn runs, and draws it in both appearances whichever is passed. `dock` walks only the chat dock, and is
the one walk that starts with it open, as a person does: the others close it to keep their pages whole. A planning or chat step sends a real turn to the agent, using the machine's Claude login.
The older diff step needs a card with a branch: that API's `code_root` is its own scratch repo (see
`wilson.projects`), so make a branch there and set `wilson.cards.branch`. `Walker.ScratchBranch` does
this for the findings step, which brings its own card.

`dotnet run --project tools/Walk -- keychain` round-trips a throwaway item through the real Keychain.
`menubar` as a sixth argument walks only the menu bar panel. `apps` as a sixth argument walks only the list and page around an operator app, with no web view in it, as the headless platform has none. `app-probe` and `app-live` need a real window: see Operator apps.

The walk is headless and has no menu bar. Ask macOS instead, with the app running:

```bash
osascript -e 'tell application "System Events" to tell process "wilson" to get name of every menu item of menu 1 of menu bar item 2 of menu bar 1'
```

## Sign-in

The screen is deadair's setup steps: a welcome on a first run, the address, then the sign-in and any
code. A remembered server opens on the sign-in. `ServerProbe` asks `/api/health` before an address is
kept, and an address that answers moves straight on, because a server has no name to confirm. A server
with no account yet asks for one instead (`SignInStep.Account`, `OnboardingForm`), and that goes on to sign in.

## Menu bar

Closing the window hides it and the app keeps running, so `ShutdownMode` is `OnExplicitShutdown`. Only
`WindowClosing` is intercepted: Quit and a restart to update close with a shutdown reason. The Dock icon
goes with the window (`MacDockIcon`), so while hidden there is no application menu or Cmd+Tab entry
either, and the menu bar icon is the way back. Opening the app from Finder or Spotlight still reveals it.
`tools/macos/make-tray-icon.sh` rebuilds `Assets/tray.png`, a template image, so macOS colours it for
the menu bar.

The icon is `MacStatusItem`, an `NSStatusItem` made directly, because Avalonia's `TrayIcon` raises no click on
macOS and does not say where it is. A press toggles `MenuBarWindow`, an undecorated window hung from the icon
in AppKit's own coordinates. It closes on losing focus and, through a global mouse monitor, on a press in another
application, as macOS can refuse it focus, and a window that never had focus never loses it. `MenuBarViewModel` reads only while it is open,
every 15 seconds, as `/api/stats` sums the event log on each request. The sums are `Core/MenuBar/MenuBarStats`.
What a key may not read is absent, not zero. Slots are this machine's `local-stage-slots` plus those of hosts
still taking work, against `running` from the drain status, which sees local runs as well as hosts'. The daily
output ceiling has no read in the API, so the panel shows no share of it. Accounts are `AccountRules.Lines`, the
Accounts section's order and wording: a machine's own sign-in has a line only while its provider's rotation is empty.
Each line's spend is `GET /api/engine-accounts/usage` over the same 14 days, and Settings reads it over 30. Spend is
charged to an account only since the server started naming it, so older spend, the `api` engine's, a rule judge's and
a review conversation's are on no line.

`dotnet run --project tools/Walk -- <out dir> <origin> <email> <password> dark menubar` draws the panel with spending
written to the throwaway database. `menubar-live <out dir> <origin> <email> <password>` tries the icon and
window for real: it adds a second icon to the menu bar and captures the panel's part of the screen. Started in the
background it was refused focus in 3 of 6 runs, and it skips what needs focus when that happens.

## Packaging

`tools/macos/make-app-bundle.sh` builds `artifacts/Wilson.app`, signed ad hoc under the hardened
runtime. It signs with `codesign` on a Mac and `rcodesign` (apple-codesign) anywhere else, and
`SIGNER=rcodesign` tries that path on a Mac. The app is published as a single file so that
`Contents/MacOS` holds only Mach-O: `codesign` signs any other file there in extended attributes,
which only `ditto` keeps through a zip, and `rcodesign` cannot sign one at all, so the script refuses
one. Measured 2026-11-05 with rcodesign 0.29.0: a bundle it signed passed `codesign --verify --strict`
after a plain `zip -ry` and `ditto -x -k`, and launched. `tools/macos/make-app-icon.sh` rebuilds the committed `.icns`. Releases are not notarised, so
macOS refuses a first launch.

## Releasing

**Never edit the version by hand.** Run `pnpm changeset` and name `@wilson/desktop`, or the required
`changeset` job in `pr.yml` fails any PR that changes `src/` or `tools/macos/`. For a change that
should not ship, `pnpm changeset --empty` satisfies it. The paragraph becomes a line in `CHANGELOG.md`.
Name no other package: the same job fails a changeset naming one `.changeset/config.json` ignores,
because merging it would stop every release until it was removed.

1. A changeset reaching main runs `desktop-version.yml`, which opens or rewrites one version pull
   request on `changeset-release/desktop`: the bump, `CHANGELOG.md` and the mirrored
   `Directory.Build.props`.
2. **Merging that pull request is the decision to ship.** Nobody looks at the release after that, and
   installed copies offer it within six hours. The tests cover Core and not the screens, so walk the
   app first. A bad release can only be replaced by a higher version.
3. The merge changes `Directory.Build.props`, which runs `desktop-release.yml`. It publishes
   `desktop-v<version>`, and skips a version that already has a release, draft or not. It runs on
   Linux and signs with `rcodesign`, as macOS runners can go unassigned until GitHub gives up. The
   `bundle` job in `desktop.yml` builds the same zip on every pull request, kept for a week, to check
   on a Mac with `ditto -x -k` and `codesign --verify --strict`. Run by hand,
   it makes a draft.

The version pull request is opened with the workflow token, so GitHub starts no workflow for it, and
`ci-ok` is required on main. `desktop-version.yml` therefore starts `pr.yml` on the branch itself. Merge
it with the app's own button and not from a workflow: a merge by the workflow token would start
nothing either, so no release would run.

## Updates

The app checks GitHub at launch and every five minutes, using its own `HttpClient` so the operator's
token never reaches GitHub. That makes the checks anonymous, so each running app spends 12 of the 60
requests an hour GitHub allows an IP address. It downloads a newer `desktop-v*` release in the
background, and installs it only on "Restart to update", so a planning turn or a merge is never cut
off. A failed download is tried again only every six hours (`UpdateDownloadRetry`), so a bad release
is not fetched whole on every check. Check for Updates in the application menu runs the same check,
skips that wait, and also answers when there is nothing to offer, using `UpdateCheckResult.Answered`
so a GitHub that did not answer never reads as up to date.

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
planning, chat, the diff, projects, the goals list, hosts, settings, opening operator apps and making the first account. Not
here yet, so this still needs the web app: a goal's own page and its status actions, the goal strip above a chat,
installing an operator app, and making a passkey, which an app signed
ad hoc cannot do. Settings lists and removes passkeys and opens the web app to add one.
Splitting a card is not
here either, but the web app has no such control: it only shows a split's progress. There are no
notifications.

## The header

`ShellView` draws the sections, as `apps/web/src/routes/__root.tsx` does, over everything but sign-in.
A section's page is kept for the session (`ShellViewModel.ShowChat`, `ShowBoard`), so an open chat and
the chosen project survive a trip between them, and going to one clears the Back stack. Back is for
what opens from a section, such as a card. A page following the feed implements `IFollowsFeed`, and
the header shows its state and Refresh. Chat follows no feed, so unlike the web app's header, this one
shows neither there. Add a section's link in the same commit as its page, never ahead of it.

The header's appearance button steps through System, Light and Dark. `DesktopSettings.Appearance`
keeps it across a change of server, and `ShellViewModel.StartAsync` applies it before the first page.

## Projects

`ProjectsViewModel` is `routes/projects.index.tsx`, names only, and pressing one opens its board through
`ShellViewModel.ShowProject`. The board's own project menu is the web header's `ProjectSwitcher`.
`NewProjectViewModel` is `NewProjectControl.tsx` and `DirectoryPicker.tsx`, a page and not a modal:
two writes and no transaction, so a name that registered is remembered and a retry only initialises.

The flagged page is the board narrowed by its Flagged toggle, and the header's "n needs human" goes
there. On the board the count is the board's own. Elsewhere nothing follows the feed, so it is read on
each change of page, and for the project in hand where the web app reads the server's own.

`ActivityViewModel` is `routes/projects.$project.activity.tsx` and `ActivitySummary` is `lib/activity.ts`.
The header's Activity shows on a page that has a project, and Back returns to it. A re-read asks for
as many events as are showing, so one from the feed does not take back what Show older brought in.

## Operator apps

The web app's rules are in `PROJECT.md`, decision 12 and Operator apps. This runs the same thing somewhere that gives none of it for free. A native web view has no iframe sandbox and no response header, so each property is built here, and **`dotnet run --project tools/Walk -- app-probe` is what says it holds**: run it after any change to these files and on each new major macOS. It opens a window for a few minutes, runs `tools/Walk/hostile-app.html` against a server logging every connection and datagram, with each lock off as the control, and fails if a control did not get out or anything did with every lock on.

- **Why a hand-bound WKWebView.** No new dependency, as WebKit ships with macOS. `Avalonia.Controls.WebView` 12.1.1 wraps the same view, but its public surface, read and not run, shows a hook for the data store and none for the rule list or the private switches below, and messages with no frame on them. So the unsafe code would be needed anyway, with a wrapper in the middle of the security decision. A bundled Chromium is a very large addition, and the engine where WebRTC was measured getting out. Opening the page in the system browser adds no risk, but it needs a second sign-in, and whichever browser is the default is mostly unmeasured.
- **The same document, the same frame.** `AppDocument` is `appDocument` to the byte, and `apps/web/tests/fixtures/app-host.json` is read by a test on each side, along with the method table. Change it deliberately in both. An app gets an opaque origin the way it does on the web, from `sandbox="allow-scripts"` on a frame `AppHostPage.Script` makes.
- **The bridge is out of the frame's reach.** `window.webkit` exists in every frame by default, and an app's frame could post to a handler in the page's world, measured. The handler and the host script are in a named `WKContentWorld`, where the frame cannot see them, and `Receive` still checks for the main frame.
- **`AppBroker` keeps the API's bytes.** They come from the app API's v1 routes (`app.api.ck`), not the board's, so what an app receives is fixed there. It is `app.broker.ts`, but `ServerAppReads` goes under the generated clients, since an SDK model refuses to write a value newer than its build. The project is in the client's header, fixed when the page opens.
- **Navigation is stopped, then noticed.** `AppHostPage.Html` carries `frame-src 'none'` in a meta element, there being no response to send it, and it stops a frame's self-navigation as the header does on the web. `AppNavigationPolicy` is a second, independent stop before any request. Each stopped alone, per the probe's table. A second `load` still fires when the policy stops one, as in Chromium, which is what closes the app. A blocked port such as 9 fires nothing, so the page stays open, having sent nothing.
- **What only a native view can do.** `WKContentRuleList` refuses `http`, `https`, `ws`, `wss` and `file` requests. `_setPeerConnectionEnabled:` removes WebRTC, which CSP's `webrtc 'block'` does not, as WebKit ignores it just as Chromium does. Turning off the `LinkPreconnect` feature stops two things: `rel=preconnect`, which the document's policy lets through, and **a connection opened when a link with a `target` is pressed**, which the sandbox then refuses without stopping it, and which no rule list or delegate sees. That one first looked like a straggler from the unlocked run before it, and repeated with every locked run going first, which is why they do. A stray connection there is a finding, not noise.
- **Failure.** If the rules will not compile, the app is not loaded. The two private switches go through `respondsToSelector:`, so a macOS without one still runs the app, with the limit the web app has, and only `Trace` says so. That is deliberate, as the boundary is what an app can read. The probe would fail.
- `AppWebHost` makes the view when shown and destroys it when not, so leaving the page ends the app's document, and `OpenAgain` gets a new one with a new broker. A native view draws over everything Avalonia draws in its rectangle. `StepUpViewModel`'s overlay would be under it, though none of the five reads needs a step-up.
- Installing stays in the web app, whose Settings already does it behind a step-up.

## Lanes

`LanesViewModel` has no web page to follow. Lanes belong to a project, so the header's Lanes opens it from a page with a project and it reads through `ForProject`. Instructions and `settings` are edited here, and `settings` is a JSON box because the server alone knows which keys exist. `LaneRules.ReadSettings` sends only what changed, with a removed key as null, as the API patches. Mode, worktree and routes are only shown, so they still take `wilson stages`. The page's Stage routing is `StageRoutingControl` on that project's client. The same control in Settings, like the web app's, sends no project and so covers the server's default project, which it says. Its templates are in `App.axaml` for both pages.

## Goals

`GoalsViewModel` is `routes/goals.index.tsx` and `GoalRules` is `lib/goals.ts`'s `isOpen`, `statusColor` and
`GOAL_REFRESH_MS`, kept in step by hand. Goals belong to no one project in the list, so it is a section, reached
from anywhere, and `GoalReads` takes the connection's unscoped `Sdk` rather than `ForProject`. It takes the status and
thread filters `ListGoalsQuery` has, and refuses `Unknown`, which has no wire spelling. The feed says nothing of goals,
so the page reads every ten seconds, as the web app does, and redraws only what changed. Open goals (`active`,
`paused`) come first and the rest under Finished, each newest first. The badge is green, yellow, blue and gray as on the
web: `Good`, `Caution`, `Done` and `Quiet`, and `Done` is the one brush in the app that is only for this. A row opens
nothing yet, as the goal's own page is not here.

## Hosts

`HostsViewModel` is `routes/hosts.tsx` and `HostRules` its wording. The feed says nothing of hosts, so the
page reads every ten seconds, and panels are kept by name across a read, as a redraw would lose a form
half filled in or close a menu. As on the web, there is no minting of a worker's token: `wilson host` does that.
Only a worker has a connection to show (`HostRules.Connection`), which is the present, where the probe badge is the past.
The machine's reading comes with the host, as the daemon samples it every thirty seconds, so it is never older than that and a bit. Recent runs are read with the hosts, one request a host, and the newest five show until asked for the twenty the API gives.

## Settings

`SettingsViewModel` is `routes/settings.tsx`, without its "back to the board" link, which the header
replaces. `SettingControls.cs` holds its three shapes, each with the web control's rule about a refusal:
`SwitchSetting` shows what came back, `NumberSetting` puts the stored value back, and `TextSetting` keeps
the attempt beside what is really stored. `ShellViewModel.Drain` is `lib/drain.ts`: read every five seconds
while draining and every minute otherwise, from sign-in on, for the header's badge on every page.

`MachineSignInControl` and `AccountsControl` are write-only: the API gives back where a sign-in comes from
and names, never a token, so nothing here can show one. `AccountRules` is `lib/accounts.ts`, and limits are
read with the page rather than every minute as the web app reads them. `ChatEngineControl` is a draft and a Save.
`StageRoutingControl` is `StageRoutingControl` in `settings.tsx`, a row per lane that reaches a model, each saved on its own. Lane fields other than routing, such as instructions and budgets, are edited with `wilson stages`, as on the web.

## Running `claude setup-token`

Measured on Claude Code 2.1.317, started with a minimal environment as an app opened from Finder would be:

- It needs a terminal. With its output on a pipe it printed nothing and waited until killed after 4 minutes.
  In a pseudo-terminal it opened the browser and finished about 9 seconds after starting, once authorized.
- .NET has no pseudo-terminal, and forking from a managed process is unsafe, so `/usr/bin/script -q /dev/null` provides one.
  It passes the exit code through, and takes a pipe as stdin.
- At 400 columns the token sits on a line of its own. Two runs gave `sk-ant-at01-` at 107 characters and
  `sk-ant-oat01-` at 108, so nothing here depends on the prefix's middle or an exact length. Prose comes
  out with cursor moves in place of spaces. The sign-in link is printed too, so it can be opened in another browser.
- The browser asks the person to authorize, even when already signed in, and that took seconds. The output names no
  account, so the token is whichever account that browser has, and nothing here can tell which. The form says so up front.
- A fresh `CLAUDE_CONFIG_DIR` keeps it off the login on this Mac. It wrote only under that folder, and made no Keychain item.
- The output is for people to read and is no interface, so a token that cannot be found is a reason to fall back on
  pasting. A token must never reach a log, an error or a `ToString`.
- `MacClaudeSignIn` is all this, behind `IClaudeSignIn`. `tools/Walk` gives it a stand-in `claude`, so a walk makes no token,
  and `tools/Walk -- signin` with no path runs the real one, which does make a token valid for a year.
- `npm` installs `claude` as a native binary, but under nvm's folder, which is not on an app's `PATH`.

## Feed activity

`CardFeedLog` is `lib/feed.ts`'s `activity` and `toolLog`: display state kept per connection, never
folded into a card, which only a re-read changes. Each page following the feed has its own, because the
desktop feed is per page. A tool event changes no card summary, so it updates a tile in place. A tile
is never redrawn for one, or for the ten-second clock, as that would lose its column's scroll.

## A card

`CardSections` is `lib/card.ts` and `CriteriaPanel.tsx`, and `CardAttempts` is `lib/attempts.ts`, both
kept in step by hand as the web app keeps its own copy of the API's. The Plan tab reads as the web page
down to the plan, with Live activity above Files in scope. Activity holds Attempts, Events, Usage and
Versions. Context holds attached snapshots and dependencies. The web app's history is 50 rows and this one's 100, as the tool list seeds from it.

## Planning

`PlanView` follows `DraftPane.tsx` and `CommentableDraft.tsx`: `DraftEdit` is whose edit wins, the draft
is read again every four seconds, and nothing is written until the changes have been seen. Comments
are `PlanAnchors`, `lib/anchor.ts`, a quote and its surroundings and never an offset. **Both clients must
anchor against the same text**, `ChatMarkdown.RenderedText`, which is the web app's `textContent`, or a
comment made in one reads as outdated in the other. `MarkdownView` marks and selects by offsets into
that text. A selection stays within one block, unlike the web app's, and a passage in a code block is
found but not marked. Comments are listed under the draft rather than in a popover over the mark.

## Comments on a diff

Selecting a numbered line opens the composer under the diff, not under the line as on the web, as a
`ListBox` row cannot hold a form. `CardViewModel.Findings` keeps the batch across files, and one request
sends it, because the server moves the card once. Only a `ready` card takes findings: the server says so.

## Dragging

`BoardView.axaml.cs` draws a drag and `BoardRules.Drop` says what it means. A tile stays a `Button`, and
capturing the pointer past eight pixels is what takes the press from it, so a click still opens the card.
A move only asks: `BoardViewModel` never changes a card's stage, and no redraw lands while a card is held.
A reorder within the parking lot is the one optimistic write, as on the web board.
Redraws wait from the press, not the drag: replacing a button under a press would swallow its click.
`LetGo` is posted so the release reaches the button first. Escape is a drop on nothing, and a collapsed
column is still somewhere to drop. `StateIcon` strokes the face in the colour behind it, since the
brand's SVGs cut it out with a mask, so it only suits a solid backing.

## The chat dock

`ChatDockViewModel` is `ChatDock.tsx` and `ChatDock` is `lib/chat.dock.ts`, kept in `DesktopSettings`. Unlike the
web app's, it starts open, so chat fills the home page and is a sidebar on every other page until someone closes it.
That is stored as `Closed`, because every older file says `Open: false` whether or not anyone chose it. It is the
chat page's own `ThreadsViewModel` beside another page, so there is one conversation: `ShellViewModel.SyncDock`
shows that page while the dock is open, as a page follows its stream only while shown, and hides it again
unless it has come to the front itself. Cmd+J sits on the window, as nothing need have the focus, and does
nothing on chat. A resize is written when the drag ends, not on each move. There is no phone drawer here.

## Chat follows the web app

`Views/ChatView.axaml` and `ThreadsView.axaml` follow `apps/web/src/components/Chat*.tsx`, and `ChatRules`
carries the same rules: change one and look at the other. A new chat has no thread until its first
message. `MarkdownView` builds controls from `ChatMarkdown`'s records, the subset `Markdown.tsx` draws,
and a card's plan is drawn with it too. `[[nnnn]]` is `MarkdownInline.CardRef`, which `MarkdownView`
raises to the shell. It opens in the project being read, and for chat, which has no project, the one
last shown, where the web app's home page has no link at all. The open chat is `DesktopSettings.Thread`.

The composer's keys are the web app's, plus `MacTextKeys`: a browser's textarea gets the macOS text shortcuts
from the system and `TextBox` does not. Each is said in keys `TextBox` knows, so undo still works. Ctrl+A, E
and K, and Ctrl+Shift+A and E, act on the line as wrapped, where macOS means the paragraph. Other boxes do not have them yet.

## Verified

2026-11-01, against the throwaway API with `tools/Walk`: sign-in and its refusals, the board live from
the feed, creating and editing a card, moving one, a merge refused by the server, opening a planning
session, saving a draft (refused by the server's own check), comments, a real planning turn, a real
chat turn, chat as the home page opening the latest thread and surviving a trip to the board, and a
diff of a real branch (that diff step was not repeated after chat became the home page). The Keychain
round trip passed on a real Keychain, and `Wilson.app` launched and opened its window. The first
release built, signed and published from the workflow, and that download launched from `/Applications`.

2026-11-05, operator apps, on macOS 26.6 and WebKit from that release. `tools/Walk -- app-probe`, in a real window and again as a copy signed with the hardened runtime and `wilson.entitlements`: with every lock on, none of 23 requests, WebRTC's datagrams or 16 ways of leaving reached the server, an opaque origin, no storage, no `window.webkit`, and only `listCards` and `getCard` reaching the broker with `board.read`. The unlocked control got out by every request and the leaving ways the sandbox itself does not stop. `tools/Walk -- app-live`, against the throwaway API in the real shell: Apps in the header, the same app reading only its own project's cards in two projects, three calls refused for want of a grant, `onChange` from a real move through the feed, a change of scheme, and an app that navigated being closed and opened again. `tools/Walk -- ... apps`: none installed, the list, and an app that has gone. Not seen: a real `Wilson.app` opening one, macOS before 26, a person's right-click menu (Reload would close the app) or a file dropped on the view, a real DNS name (`.local` lookups were watched by multicast, and images caused them unlocked and not locked, but `rel=dns-prefetch` caused none even unlocked, so that switch is unproved), and the app against Tower.

2026-11-04, proposed changes: with `tools/Walk -- ... actions`, in the dark appearance, rows written to the throwaway database and read back through the API as labelled fields, a body as Markdown in its scrolling box, a list as JSON and the raw view. `ChatArguments` is `lib/chat.arguments.ts`. A proposal from a real agent turn was not seen, and neither was Confirm.

2026-11-01, chat: with `tools/Walk`, the greeting, Tab, typing and Enter by headless keyboard, a real
streamed turn, Markdown, the working state, rename and archive, in both appearances. A proposed
change was posed, as nothing makes the agent propose one on cue.

2026-11-02, header: with `tools/Walk`, in both appearances, the sections and their marker, live status
and Refresh on the board and a card, leaving a card for either section, the same board and chat coming
back, no header on sign-in, and signing out from it.

2026-11-02, appearance: with `tools/Walk`, all three drawn and read back from the settings file.

2026-11-02, board filter: with `tools/Walk`, the filter and its count, a flag's reason, a blocked card and
split progress, the last three from rows set by hand on the throwaway database.

2026-11-02, tile activity: with `tools/Walk`, a `tool.executed` row and its `pg_notify` written to the
throwaway database reached a tile through the real feed. `Walker.Emit` is that writer, as nothing
runs a stage there. The stale style was not seen on screen: five minutes is longer than a walk.

2026-11-02, card tools: with `tools/Walk`, none said, then executed and denied calls arriving through the
real feed. The merge with a fetched tail is proved in `ToolRowsTests`, not on screen.

2026-11-02, dragging: with `tools/Walk`, by Avalonia's headless pointer input through the real views, a
click and a three-pixel slip opening a card, the held tile, ghost and target column, a drop moving a card
through the API, and a drop refused because the row had gone. The server allows nearly any move, so that
refusal is the only one a walk can pose. Not seen: scrolling at the window's edge, a real trackpad, and
losing the pointer mid-drag.

2026-11-02, parking lot: with `tools/Walk` in both appearances, a card dropped over another shown at once
and read back from the server, put back the same way, and a refused reorder rolled back. The other
neighbour arguments (to the bottom, down the lot) are proved in `BoardRulesTests`, not against a server.

2026-11-02, the chat dock: with `tools/Walk`, the shortcut through headless input, a drag resizing it and
stopping at the limit, a real turn in the dock, moving it, the picker, the home page showing the same chat,
Cmd+J doing nothing there, and each kept in the settings file. Arrow keys on the handle were not walked.

2026-11-02, the chat as a sidebar: with `tools/Walk -- ... dock`, on a file that never touched the dock, no dock on
the home page, the same chat beside the board and settings, the board live beside it, Cmd+J closing it for good, and
the drags above. The turn came back as the login's usage-limit message, so a full answer in the sidebar, and leaving
the home page in the middle of one, were not seen. An older file opening it is in `ChatDockTests` only.

2026-11-02, the composer's keys: `MacTextKeys` in a throwaway Avalonia app on the native platform, with real
key events posted to that process, each key's effect on the text, and undo and redo after Cmd+Backspace. With
`tools/Walk`, Ctrl+A, E, H, K and Cmd+Backspace in the real composer through headless input. Not seen: the
real composer under a real keyboard, Ctrl+K on a wrapped line, and Enter during input-method composition.

2026-11-03, the composer's selecting keys: a keyboard that sends Home as Ctrl+A and Shift+Home as Ctrl+Shift+A, read
from real key presses logged in the real composer on the native platform. With that keyboard, Home and End with
and without select, in a build of this code but not a packaged app. Ctrl+Shift+B, F, N and P by posted key events
there, and Ctrl+Shift+A and E with `tools/Walk`.

2026-11-02, first run: with `tools/Walk -- ... firstrun`, on a second API on port 13151 and a database made
empty for it, then dropped: the server asking for an account, passwords differing, the policy's advice, the
account made and signed in, and that server then asking for a password. An account made in between
checking and creating (the 409) is in `SignInWordsTests` only.

2026-11-02, security: with `tools/Walk`, on a real session past the five minutes, a real step-up refused,
cancelled and answered with the request replayed, a real authenticator enrolled from its secret, wrong
codes refused, a real sign-in with a code, and removing it. `Walker.Totp` stands in for the phone, so the
QR code was seen and not scanned. A step-up answered with a code, and a passkey listed or removed, were not
walked: the first needs the session to age again and the second needs a browser to make one.

2026-11-02, engine settings: with `tools/Walk`, a config directory and a token refused, a made-up token
saved and removed, a worker token listed and removed, an app id saved, and the chat engine saved and put
back. No real token was used, so a sign-in with one was not tried, and the GitHub key's found state and a
chat on the AI SDK were not seen.

2026-11-02, runner settings: with `tools/Walk`, each read and written and put back on the throwaway API, a
drain reaching the header on another page, an interval refused and a webhook refused keeping the attempt.
Auto-mode was flipped only under a drain, as that API must never start work. Draining with a stage running
was not seen, as nothing runs a stage there.

2026-11-03, lanes: with `tools/Walk`, in the dark appearance, instructions and settings saved, a key removed and one added, a fresh page reading the same, a box that cannot be read, a value refused keeping the attempt, a real step-up answered with the save replayed, and all of it put back. Routing saved on a second project's page, read back from the API with the first project's unchanged, and a route's step-up cancelled keeping the attempt. Not walked: a route's step-up answered, and a real stage running on an edited lane.

2026-11-03, stage routing: with `tools/Walk`, in the dark appearance, a model saved and put back, Codex fixing the provider, the AI SDK offering one, a route refused keeping the attempt, the shared-provider warning appearing and going, and `ready` offering only a model, its `review` and `ready` rows written by hand. A save behind a real step-up was not walked, as the session was too young to need one, and neither was a real stage run on a changed route.

2026-11-02, hosts: with `tools/Walk`, registering, a taken name refused, drain, disable, serving a project,
a real probe failing, an engine token assigned to a worker, and removing after being asked. A running slot
was a `wilson.leases` row written by hand. A probe that passes needs a machine, so it was not walked.

2026-11-03, a worker's connection: with `tools/Walk`, a worker never connected, then a socket connecting to the
real endpoint and saying hello, found by the page's own reading and drawn, then dropped and found gone. That socket
is `Walker.ConnectWorkerAsync`, so a real worker program was not behind it, and its token was written to the row.

2026-11-03, a host's recent runs: with `tools/Walk`, none, then each ending and a running one in order, showing all
and fewer, and a run opening its card. The runs were `wilson.card_events` rows written by hand, as nothing runs a stage there.

2026-11-03, a machine's reading: with `tools/Walk`, none for an SSH host or a worker not connected, then the daemon's
own sampling reaching the page from `Walker.ConnectWorkerAsync`'s made-up numbers, a low disk flagged, and gone with the connection.
Read through the API, not on this page: the real `apps/worker` on this Mac, its disk agreeing with `df`. macOS counts little as free, so a worker
run natively there reads as nearly out of memory; `my-mac` is in Docker, on Linux, where it was not seen.

2026-11-02, a new project: with `tools/Walk`, on the throwaway API and its own scratch repo, the folder
picker, a missing folder opening its parent, the roots following the code root, a taken name refused
and a real registration reaching a board. The GitHub repository list needs an app, so it was not
walked, and neither was a failure between the two writes.

2026-11-02, activity: with `tools/Walk`, the project's events, one arriving through the feed, and a row
opening its card.

2026-11-02, flagged: with `tools/Walk`, the header's count away from the board, the narrowed board, and
nothing flagged.

2026-11-02, projects: with `tools/Walk`, the page and a real press on a project opening its board.

2026-11-02, planning: with `tools/Walk`, a real drag selecting a passage in the preview, a comment
anchored and marked, a rewrite leaving it outdated, resolving it, the changes shown before a save and
a refusal staying on that dialog. A collision is covered by `DraftEditTests` only, and a comment made
in the web app and read here has not been tried.

2026-11-02, comments on a diff: with `tools/Walk`, a real branch in the scratch repo, composing on a
line, a batch across lines, removing one, and sending it, which moved the card back.

2026-11-02, context and dependencies: with `tools/Walk`, adding and removing a dependency, a card that
does not exist and an address no provider handles both refused and kept in the box, and removing a snapshot. A
successful attach was not walked, as fetching needs the internet, so that snapshot was written by hand.

2026-11-02, a card's history: with `tools/Walk`, criteria with a review's verdict, files in scope, a
placed run, its attempt, the usage table and versions. The run was written to the throwaway database.

2026-11-05, menu bar panel: with `tools/Walk -- menubar-live`, in real windows against the throwaway API. The
panel opened under the icon, closed on a second press and when another window took focus, and opened with the
Dock icon gone. Its frame was centred on the icon, 4 points below the bar, on a 5120 by 1440 display.
The operator then ran it with `dotnet run` against their own server, used the icon by hand and reported that it works.

2026-11-05, the menu bar's accounts: with `tools/Walk -- ... dark menubar`, two tokens in rotation and their limits written
to the throwaway database, the limited one in words, the other as Next, and a limit on `local` left out. Each one's spend,
from stage events charged to one of them, read through the real endpoint. Not seen against a real server or a real engine's spend.

2026-11-02, Markdown: with `tools/Walk`, a card's plan drawn as Markdown and a real press on `[[0001]]`
opening that card.

2026-11-02, the board: with `tools/Walk`, through headless pointer input, collapsing columns and
dropping on one, the faces on tiles, a click surviving a re-read during its press, and Escape.

2026-11-01, updates: a real 0.0.1 bundle updated to a real 0.0.2 signed by `openssl` as the workflow
does, relaunched with its window and passed `codesign --strict`. A tampered zip and a version the
signature did not name were both refused.

2026-11-05, a bundle built on Linux: the `bundle` job's zip, signed by rcodesign 0.29.0 on `ubuntu-latest`,
passed `codesign --verify --strict` after `ditto -x -k`, with the hardened runtime on every Mach-O and the
entitlements intact. `tools/Walk -- update` installed it over a bundle built here, with a throwaway key, and
the relaunched app was running 23 seconds later. Not seen: a release built by the Linux workflow itself.

2026-11-01, menu bar, on a real `Wilson.app` through macOS Accessibility: the close button and Cmd+W
hid the window and left the app running, the icon's Open and the Dock icon brought it back, and the
icon's Quit and the app menu's Quit each ended the process.

Not verified:

- The panel on a second display, or in a real `Wilson.app`: the live walk presses the icon through AppKit's
  `performClick:`, and the operator's own try was through `dotnet run`.
- An update through the running app's own button, or from a real release.
- A session, and the open chat, surviving a relaunch of the real app. Keystrokes reach the views in
  the walk through Avalonia's headless input, not a real keyboard.
- The app against Tower or the real board.
- A confirmed chat action, an acknowledged flag, a successful merge, and a token refresh or reconnect
  against a real server: the seeded board offers none, and the last two are proved against `FakeServer`.
- Pressing a web link in an answer, or the options menu on a chat in the rail, in a real window: the walk
  calls the rename and archive commands directly.
- Either GitHub workflow.
