# Review measurement

Whether a change to the review stage helped. It runs the real stage on diffs with a known answer and scores what comes back. It is for comparing one model or prompt with another, run against the same corpus.

## Running it

From `apps/api`:

```bash
pnpm eval:review --snapshot <stages.yaml> --prompt-revision <label>
```

That is a dry run: it seeds every case and starts no model, so it is free. Adding `--confirm-spend` runs the reviews, one at a time, and spends model usage on the operator's own credentials. Ask before doing that, and start with a few cases. It refuses to run when `CI` is set, and no test or workflow starts it.

- `--snapshot` is a whole stage config document: the `review` lane, routed to the `cli` engine, and every lane it routes to, which can be stubs. The live prompt is only in the database, so this is a copy of it taken by hand. Its budgets apply, so lower `maxInputTokens` for a small run.
- `--prompt-revision` labels that copy, usually with its lane revision. The report also records a hash of the prompt, so a mislabelled snapshot can be noticed.
- `--cases a,b` runs only those cases, `--model` overrides the snapshot's model, `--out` sets the results file, and `--keep` leaves the scratch directories behind.
- `--max-output-tokens <n>` stops starting new cases once that many have been spent. It is checked between cases, so a run can pass it by one case, and a case whose engine throws reports no usage to count.

The results file is rewritten after every case, so a run that stops early keeps what it paid for. It also stops by itself if the account runs out of usage. A case that throws is listed under "Not scored" and the run moves on. `notRun` in the results file lists the planned cases with no result, even if the process was killed, and the report opens by saying so.

The report goes to the terminal. The results file holds every finding, and it stays out of the repository.

`pnpm eval:review --rescore <results.json>` scores a saved run again with today's truths and rules, and spends nothing. What the reviewer reported and what the verifier said stay as they were, so a fix to how a case is seeded shows only in a new run. `--out` writes the new results file.

## A case

`cases/<id>/` holds:

- `case.json`: `base`, the commit to start from, `source`, the merged commit the patch came from, and the card's `title`.
- `plan.md`: the card body the reviewer reads, which says what the work is and not what is wrong with it.
- `change.patch`: the diff under review.
- `truth.json`: the hidden answer. For a defect, its `class`, `file`, any other files a finding could fairly name (`alsoIn`), `lines`, the words a finding must use (`mentions`), what it is, and the commit that fixed it. For a control, why it is believed clean.

Each run gets a scratch repository holding the base's tree as one commit, with the patch committed on a card branch. There is no history to read, nothing from this directory inside it, and a card id that is only a position.

The bases are named by commit rather than copied here, so the corpus stays small and old code does not show up in the repository's own searches. It needs a full clone. CI's checkout is shallow, so there the corpus test checks each case's own files but not that its patch applies.

## Where the cases came from

**Defects** are real ones from Wilson's history, not invented. Each started from a merged fix, traced by blame to the commit that introduced the mistake. The patch is that commit, without its lockfile changes unless it edits a `package.json`, and the base is its parent, so the reviewer sees the work as it first arrived. A patch that edits a `package.json` needs them, or the first install rewrites the lockfile and the verifier blames the reviewer. One comment in `defect-merge-check-branch` was reworded to drop an outside reference, which changes no code. Candidates were dropped when the fix depended on code that came later, so the mistake was not yet a mistake, or when the blamed commit only moved code that was already wrong.

**Controls** are merged commits with no sign of a later correction: at least three quarters of their lines survive, and none of the next six commits to their files reads as a fix. That is evidence, not proof. A blocker on a control may be a real find, so read it before counting it against the reviewer.

The `lines` run six lines either side of what the fix changed. They are for a person, and matching ignores them: a finding can name a defect from where it is called, and one on those lines can be about something else. The first real run got 7 of 20 cases wrong by location, in both directions.

The `mentions` were written after that run, while reading its findings, and every case was then checked against a person's reading of them. So they fit that run better than they will fit the next: expect some misses in a new run to be a reviewer's different wording, and read them.

The plans were written for this corpus from the commit messages and diffs, because most of the original cards are gone. A real plan may say more or less than these do.

## Reading the scores

- **Recall** is defect cases with a finding about the defect, in one of its files and using all of its `mentions`, over defect cases. It is reported twice: a blocker there, which is what sends work back, and any finding there.
- **Specificity** is controls that passed with no blocker, over controls.
- **Raw** is what the model reported. **Verified** is what the runner would act on: a result `ReviewVerifier` refuses counts as a miss.
- A run that stopped short (engine failure, budget, usage limit, a question, out of steps, no report) says nothing about the review. It is listed and left out of every `n`.

What these numbers cannot say:

- **They stop at review.** A blocker still has to survive challenge, so review-only scores overstate what would reach a kickback.
- **A match is a file and some words.** A finding can use the words and mean something else, or say it differently and be missed, so read the matched findings and the misses before quoting recall.
- **The reviewer had less to go on than a live one.** Type-check evidence is left out, and rule judges and learnings need a board. Unwired-symbol evidence does run. The lane's setup command does not, but `pnpm` installs dependencies the first time a reviewer runs it, so it can still build and test.
- **A snapshot's lanes are not all there.** With stubs for the other lanes, the plan loses the note saying which paths those lanes may add.
- **Findings cap at 20.** A review at the cap could not report more, and the report counts how many reached it.
- **`n` is small.** One case moves recall by five points and specificity by ten, so compare runs by the cases that changed. Each case also runs once per run, and a model does not answer the same way twice.

## What a run can reach

A scratch repository is not a sandbox. A reviewer runs the lane's `allowedCommands` on this machine, in the operator's environment, and `pnpm exec vitest run` can execute any code it writes. In the first real run, one reviewer ran 1,240 of a base's tests and another probed the local test Postgres on port 15533 in a throwaway schema.

So a run exercises the shared test database with old commits' code, and can collide with other test runs on this machine. Point a run at its own database with `TEST_DATABASE_PORT`, which the engine passes through to every base with database tests. Older bases have no such tests, and some predate the setup that migrates the database, so migrate it first by running any API test with the same variable set. That stops the test suites sharing a database, but a reviewer writing its own probe could still read the default port from the repository. Taking the test commands out of the snapshot's `allowedCommands` avoids this, but it measures a different reviewer, so label it as such.

## Adding a case

Add the four files and run the corpus test, which checks that the truth lies on lines the patch adds, the plan gives nothing away, and the patch applies to its base. Then do a dry run. A new case changes what the scores mean, so don't compare across it.
