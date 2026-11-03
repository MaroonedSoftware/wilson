# @wilson/desktop

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
