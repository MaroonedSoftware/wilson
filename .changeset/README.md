# Changesets

A changeset is a file here that says a change to the desktop app should ship, how far it bumps the
version, and a line for the changelog. `pnpm changeset` writes one. Only `@wilson/desktop` is released
this way: the server ships from `main` as an image and has no version of its own.

`apps/desktop/CLAUDE.md`, under Releasing, has what happens next.
