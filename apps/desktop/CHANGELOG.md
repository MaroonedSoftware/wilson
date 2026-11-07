# @wilson/desktop

## 0.23.0

### Minor Changes

- 1775773: Chat now shows the questions Wilson asks: pick an option, or several where it allows, or type your own under "Other", then Submit. A question set aside by a message, or past its ten minutes, says so.

## 0.22.0

### Minor Changes

- 780f643: A merge that opens a GitHub pull request now reads "Opened pull request #n" instead of a refusal, and a card whose pull request is open or merged shows a button to it in Merge's place. A closed pull request shows Merge again. The activity list names the pull request opened and closed events.

## 0.21.0

### Minor Changes

- 2f01d1b: Goals in the header lists every goal, as the web app's goals page does: open goals first and finished ones under their own heading, each newest first, with its project and a status badge in the web app's colours. It reads again every ten seconds.

## 0.20.2

### Patch Changes

- bc129ee: A card's activity names a test that was already failing before the card, which the testing stage and the merge check no longer hold against it.

## 0.20.1

### Patch Changes

- 07ab1b0: Each engine account shows what it spent today and recently, under its name in the menu bar and beside its kind in Settings. This needs a server that serves account usage; an older one shows the accounts without it.
- d4fedff: The menu bar lists the accounts engines sign in as, in rotation order, with the next one marked and any limit in words. A limit left on a sign-in no engine uses is no longer shown.

## 0.20.0

### Minor Changes

- 5636834: An operator app written for a version of the app API this build does not offer is not opened, and its page says why. This needs a server that records each app's API version.
- eb62006: An operator app can open one of the project's cards with `wilson.openCard(id)`, which leaves the app for the card's page.

### Patch Changes

- 8e05c9a: Operator apps read through version 1 of the app API, so they receive the same fields in the desktop and web apps. This needs a server that has the app API.

## 0.19.1

### Patch Changes

- 177c6f0: The app is now published as a single file, and the bundle can be signed with rcodesign where Apple's codesign is not available.

## 0.19.0

### Minor Changes

- 57ffa29: The menu bar icon now opens a panel of stats: slots in use, pass and cache rates, 14 days of token use, today's figures, and each project, host and account limit, with Open and Quit below them.

## 0.18.0

### Minor Changes

- 66d1103: Open installed operator apps in a locked-down web view, from Apps in the header of any page with a project.

## 0.17.2

### Patch Changes

- dfeb89f: The activity feed now names the two events checked rules write: judges looking at a review's diff, and a rule being proposed after a kickback.

## 0.17.1

### Patch Changes

- e8c601a: The app now looks for a new version every 5 minutes rather than every six hours. A download that fails is tried again every six hours, or at once from Check for Updates or when a newer release appears.

## 0.17.0

### Minor Changes

- 1f64883: A card whose stage stopped to ask a question now shows the question, what the stage already tried and any likely answers, with a box to send an answer. The stage then runs again in a fresh session with the answer in its plan. Needs an API with the answer operation, so deploy that first.

## 0.16.0

### Minor Changes

- 28d6417: Show what Merge would do on a `ready` card, on the board and the card page.

### Patch Changes

- 4da0eb6: Name engine compaction in a card's activity.

## 0.15.0

### Minor Changes

- 08b0e56: A change the chat proposes now reads as labelled fields instead of raw JSON, with long text drawn as Markdown in its own scrolling box. Raw JSON on the card shows exactly what Confirm will send.

### Patch Changes

- fcfc69a: Fix the board going blank or stale after a card was opened: clicking a card left the board unable to redraw, so it stopped following changes, and switching project showed no lanes or cards.

## 0.14.0

### Minor Changes

- fdb9522: A project has a Lanes page, opened from the header beside Activity, that edits each lane's instructions and its settings such as budgets and allowed commands, and sets that project's own stage routing. The Stage routing section in Settings now says it covers the server's default project.

## 0.13.0

### Minor Changes

- ab112c8: Settings has a Stage routing section: choose the engine, provider and model each lane runs on, and see when review and implementing share a provider.

## 0.12.0

### Minor Changes

- 9f2d786: The chat takes images: attach them from the composer and see them in the conversation.

## 0.11.0

### Minor Changes

- 1ae790c: A board tile says how a finished card ended: merged, poisoned, dropped or split.
- 22dac86: Approving a plan shows its scope check: a tile and card say when it is checking or refused, with the reason, and a refused card can be split as proposed.

## 0.10.0

### Minor Changes

- 060c6fa: Show whether a worker host is connected right now, with its version and platform, on the Hosts page.
- f19b454: A worker host on the Hosts page shows how its machine is doing: load, memory, uptime and the free space on each volume holding its projects. A volume with under a tenth free is flagged. Wilson and its workers must be updated together for this, as the worker protocol changed.
- 163eb30: Each host on the Hosts page lists its recent runs: how each ended, how long it took, and a link to its card.
- 6a592b4: Planning on desktop opens on the rendered draft. Select a passage to comment beside it, then send the open comments to the agent as one revision request with Send feedback. A finished turn resolves the comments it delivered, and Reopen sends one again. Approving a plan now also updates the session's draft, so edits no longer revert and the agent sees them.
- aef3412: Adding a Claude account can now be done with a Sign in with Claude button, which runs `claude setup-token` and saves the token without showing it. Pasting a token still works.

## 0.9.0

### Minor Changes

- 5a656e0: Settings has an Accounts section that says which account the next engine signs in as. It groups accounts by how each is used, shows limits on the account they apply to, sets the rotation order, replaces a token in place, asks before removing one, and explains where a new account's token comes from.

## 0.8.1

### Patch Changes

- bab17d5: The chat box now selects with Ctrl+Shift+A, E, B, F, N and P, the selecting forms of the Ctrl shortcuts it already took.
- 9f8083f: Say the server could not be reached when a proxy answers 502, 503 or 504 with no reason of its own, instead of only naming the status.

## 0.8.0

### Minor Changes

- 4444b59: Hide the Dock icon while the window is closed. Reopen Wilson from the menu-bar icon, or by opening the app again.

## 0.7.0

### Minor Changes

- 9aba73a: Settings shows which worker engine tokens are pooled and any usage limit in force, and adds or removes a token from the pool.

## 0.6.0

### Minor Changes

- 2a24258: The chat now follows you off the home page as a sidebar you can resize, until you close it with Cmd+J or the Dock button.

### Patch Changes

- 3b3b1c2: The chat box now takes the macOS text shortcuts it was missing: Cmd+Up and Cmd+Down, Cmd+Backspace and Cmd+Delete, and Ctrl+A, E, K, D, H, B, F, N and P.

## 0.5.1

### Patch Changes

- e6fa57c: A plan's numbered acceptance criteria show as one item per number, however they wrap.

## 0.5.0

### Minor Changes

- 009aa5b: An Activity page shows what is happening across a project, live.
- f9e033e: A header over every page goes between Chat and the Board, and holds the live status, Refresh and Sign out.
- a465b8e: The header chooses System, Light or Dark, and the choice is remembered.
- be0f693: The board filters by id or title, and a tile shows why a card is flagged, what blocks it, and how far a split has got.
- 74dd044: Board columns collapse and stay collapsed per project, tiles wear the state faces, Escape cancels a drag, and a click no longer goes missing when the board redraws under it.
- 4f93eec: A card shows its files in scope, acceptance criteria with the latest review's verdict, attempts, split pieces, versions and a usage table.
- 1228f54: Dependencies can be edited and context attached or removed from a card.
- 9f5e46c: A card's plan renders as Markdown, and `[[nnnn]]` opens that card from a plan or a chat answer.
- 2da7183: A card's Activity tab lists its tool calls as they happen.
- d14c94e: Cmd+J docks the chat beside any page, on the right or at the bottom, and it comes back the size it was left.
- 1b4928b: Comments can be left on a line of a diff and sent back as one batch.
- b8d97a1: Drag a card between the board's columns to move it. A click still opens it.
- c40dce5: Settings now covers engine credentials and worker tokens, the GitHub App and the chat engine.
- 3d1123d: A server with no account yet can have its first one created from the desktop app.
- 2fd440f: The header counts the cards needing a human and goes straight to them on the board.
- 3385fb5: A Hosts page registers and probes hosts, drains and disables them, serves projects on them, assigns engine tokens, and shows what each is running.
- 74f1f67: Projects can be added from the desktop app, by browsing the server's folders or picking a GitHub repository.
- 6e47b5f: Planning shows a preview of the draft with comments anchored to what you select, lists comments the draft has outgrown, warns when the agent writes over an edit, and shows the changes before a save.
- 2992cf5: A Projects page lists every project on the server and opens each one's board.
- 7006991: Drag a card within the parking lot to put it in a new place.
- bd5f514: Settings can set up and remove an authenticator app and remove a passkey, and opens the web app to add one.
- c191cba: A Settings page holds auto-mode, drain, auto-split, the poll interval, stage concurrency, notification URLs and the deployment's facts, and the header shows a drain on every page.
- 4a7e663: A change that needs a recent sign-in now asks you to confirm it's you and carries on, rather than failing.
- f0e941d: A board tile shows how long a card has been in its stage and when a running card last reported.

## 0.4.0

### Minor Changes

- 8ddf0f0: Chat now works and looks like the web app's: a new chat opens on a greeting with starter questions and makes its thread on the first message, answers render Markdown and show what they ran, proposed changes sit in the conversation as cards, the composer takes Enter, Shift+Enter and Tab, and chats can be renamed and archived.

### Patch Changes

- 8b2dd00: The application menu offers About Wilson instead of About Avalonia, and a Check for Updates item.

## 0.3.0

### Minor Changes

- 555ff1b: Add a menu-bar icon. Closing the window now hides it and leaves Wilson running: reopen it from the icon or the Dock, and quit from the icon or with Cmd+Q.

## 0.2.1

### Patch Changes

- f3fdefc: Chat is the home page, sign-in asks for the server first and then the account, and the app icon matches the web app's.
