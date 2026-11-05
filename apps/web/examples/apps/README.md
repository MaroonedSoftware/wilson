# Writing an operator app

An operator app is one HTML file that runs inside Wilson's web and desktop apps and reads what you granted it.
[`board-summary.html`](board-summary.html) is a working example.

## Installing

In the web app, open Settings, then Apps. Choose the file and tick what it can read. Nothing is ticked
by default. Installing, replacing and removing all need a recent sign-in. Installed apps are listed under
Apps in the header of any project, and each opens in the project you opened it from.

Apps run in the web app and on desktop, which lists and opens them but does not install them. They do not run
on Android.

## The file

- One file of at most 512 KiB, with its script and styles inline. Anything else it needs goes in as a
  `data:` URL, for images, fonts and media only.
- It cannot load anything from a network, use `fetch`, open a popup, submit a form, run `eval`, start a
  worker or nest a frame, and it has no cookies or storage. Keep state in memory.
- It cannot navigate. A page that tries is closed, with a message saying why. On desktop that includes a link
  to a `#fragment` in the page, so scroll with `scrollIntoView` instead.

## `window.wilson`

Wilson adds this before your HTML runs. Every method returns a promise. A refused or failed request
rejects with an `Error` whose message is the reason. Dates arrive as ISO strings.

| Call                                            | Grant           | Answers with                |
| ----------------------------------------------- | --------------- | --------------------------- |
| `wilson.listCards()`                            | `board.read`    | The project's cards         |
| `wilson.getCard(id)`                            | `board.read`    | One card, with its body     |
| `wilson.listBoardColumns()`                     | `board.read`    | `{ stages, nonStages }`     |
| `wilson.listProjectActivity({ limit, before })` | `activity.read` | Recent events, newest first |
| `wilson.getProjectStats({ days })`              | `stats.read`    | What the project spent      |

Answers come from version 1 of the app API (`/api/app-api/v1`, defined in `apps/api/data/contracts/app.api.ck`).
Fields may be added to it, but none will be changed or taken away. An optional field is left out, not sent
as `null`, unless it says otherwise.

| Answer                   | Fields                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A card, from `listCards` | `id`, `title`, `stage`, `dependsOn`, `needsHuman`, and when set `doneReason`, `planCheck`, `planCheckReason`, `branch`, `needsHumanReason`, `blocked`, `position`, `splitFrom`, `stageEnteredAt`, `mergeStatus` |
| `getCard`                | A card's fields plus `body`, `sections` and, for a card that was split, `pieces`                                                                                                                                |
| An activity event        | `id`, `cardId`, `cardTitle` (`null` once the card is gone), `type`, `stage` (may be `null`), `createdAt`. Not what the event carried: open the card for that                                                    |
| `getProjectStats`        | `since`, `until`, `zone`, `total`, `stages`, `days`, `topCards`, `conversations`, all token and attempt counts                                                                                                  |

An app may have 16 requests waiting at once. Past that, a request is refused until one finishes.

| Also there                       | What it is                                                  |
| -------------------------------- | ----------------------------------------------------------- |
| `wilson.project`                 | The project the app was opened in. It can read no other     |
| `wilson.grants`                  | The grants it was installed with                            |
| `wilson.colorScheme`             | `light` or `dark`                                           |
| `wilson.onChange(fn)`            | Calls `fn` when the board changes, if the app has any grant |
| `wilson.onColorSchemeChange(fn)` | Calls `fn` with the new scheme                              |

`onChange` and `onColorSchemeChange` each return a function that stops listening.

`onChange` carries no detail, so read again to see what changed. It follows the same feed as the board,
which has no event for a newly created card, so a new card shows up with the next change or the next
read.

Wilson sets the page's `color-scheme`, so browser defaults already match its theme. The frame's
background is transparent unless you set one.

Text from a card is whatever its author wrote. Put it in the page with `textContent`, as the example does,
not `innerHTML`.

## What the sandbox does not do

It keeps your session, your credentials and anything you did not grant away from an app. It does not stop
an app sharing what it can read: Chromium browsers let a page send WebRTC packets to a server it names, and
no web standard turns that off from here. Grant only what you would trust the app's author with.

The desktop app also turns WebRTC off and refuses the network at the engine, and nothing got out when that was
measured. Those are switches private to the macOS web engine, so do not write an app that depends on them, or
grant it more on that account.
