## Goal

Add `wilson card release <id>`, which cancels a card's abandoned job and clears its claim without running anything. It must not release a job a running daemon may really be working on, and should say so when there is nothing to release.

## Files in scope

- packages/cli/src/commands/card/release.command.ts
- packages/cli/src/index.ts
