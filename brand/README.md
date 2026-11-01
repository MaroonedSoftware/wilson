# Wilson — brand assets

The mark is a round head with a four-spike tuft and a face made of two check
marks and a smile. The face is a knockout, cut with an SVG `<mask>`, so every
file is a single shape filled with `currentColor` and works on any background.

## Files

| File | Use |
|---|---|
| `wilson-mark.svg` | Primary mark. Inherits `color`. |
| `wilson-mark-16.svg` | Hinted variant for 16–20px: three fatter spikes, wider head, heavier strokes. Do not scale the primary mark below 24px — use this instead. |
| `wilson-app-icon.svg` | App icon: the white mark on a `#242424` tile, for surfaces Wilson does not control and whose background may be light or dark. Source of `unraid/icon.png` and `apps/desktop/tools/macos/wilson.icns`, and the same colours as the Android launcher icon. |
| `states/*.svg` | The mark reporting a stage state. Same head, different face. |

## States

The face is a slot. Both checks land only when the card actually passed.

| File | Meaning |
|---|---|
| `states/parked.svg` | In the parking lot, never dispatched |
| `states/running.svg` | Agent working in a worktree |
| `states/passed.svg` | Exit condition met, advance |
| `states/kicked-back.svg` | Failed verification, retry with findings |
| `states/needs-human.svg` | Retries exhausted; the plan is wrong |
| `states/poisoned.svg` | Dead-lettered — infrastructure, not quality |

## Rules

- One colour. The mark never carries two.
- Clear space on all sides: the width of one spike.
- Do not add a circle, seams, panels, or a letter to the head.
- Wordmark is a serif (Wilson is a person's name); mono lowercase `wilson`
  wherever the name sits next to a command.

## Note on the reference

Wilson® is a live sporting-goods trademark and the ball in *Cast Away* is
Fox/Playtone IP. This mark deliberately avoids both: no volleyball panelling,
no red W, no hand print. A round face with a tuft of hair is not ownable, and
inline `<mask>` ids are prefixed `wilson-` to avoid collisions when several
marks are inlined on one page.
