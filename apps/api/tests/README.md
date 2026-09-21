# tests

Suites mirror `src/`, path for path: `src/modules/agent/scope.guard.ts` is tested by
`tests/modules/agent/scope.guard.test.ts`.

The mirror is exact on purpose, including the `modules/` segment. Both people and agents navigate
this repo by guessing the paired path, and a layout that is *nearly* mirrored is worse than one that
is not — it looks predictable right up until it is wrong.

## Tests that need a database

The board is Postgres, so the board and dispatcher suites talk to the `db-test` service in
`docker-compose.yml` — a tmpfs Postgres on port 15533, separate from the dev database. Bring it up;
the suite migrates it itself, in a `globalSetup` (`tests/support/test.db.migrate.ts`) that runs
before any test file loads, so a container restart that wipes the tmpfs schema costs a second or
two instead of a testing attempt:

```
docker compose up -d db-test
```

To run dbmate by hand instead — outside vitest, or to check the schema without running the suite:

```
cd apps/api && DATABASE_URL="postgres://postgres:postgres@localhost:15533/wilson_test?sslmode=disable" \
  pnpm exec dbmate -d ./data/migrations --no-dump-schema up
```

Isolation is a unique project per test, from `tests/support/test.db.ts`: cards are keyed by
`(project, id)`, so no suite can see another's rows and nothing needs truncating between them. That
is deliberately the cheap version of what card 0027 wants for worktrees.

These suites use a real database for the same reason they used a real git repo before — a fake
would only prove the test agrees with itself about what a write means.
