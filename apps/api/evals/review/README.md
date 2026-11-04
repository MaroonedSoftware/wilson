# Review measurement

Whether a change to the review stage helped. It runs the real stage on diffs with a known answer and scores what comes back. It is for comparing one model or prompt with another, run against the same corpus.

## Running it

From `apps/api`:

```bash
pnpm eval:review --snapshot <stages.yaml> --prompt-revision <label>
```

That is a dry run: it seeds every case and starts no model, so it is free. Adding `--confirm-spend` runs the reviews, one at a time, and spends model usage on the operator's own credentials. Ask before doing that, and start with a few cases. It refuses to run when `CI` is set, and no test or workflow starts it.

- `--snapshot` is a stage config document holding the `review` lane. The live prompt is only in the database, so this is a copy of it taken by hand. It has to route review to the `cli` engine.
- `--prompt-revision` labels that copy, usually with its lane revision. The report also records a hash of the prompt, so a mislabelled snapshot can be noticed.
- `--cases a,b` runs only those cases, `--model` overrides the snapshot's model, `--out` sets the results file, and `--keep` leaves the scratch directories behind.

The report goes to the terminal. The results file holds every finding, and it stays out of the repository.

## A case

`cases/<id>/` holds:

- `case.json`: `base`, the commit to start from, `source`, the merged commit the patch came from, and the card's `title`.
- `plan.md`: the card body the reviewer reads, which says what the work is and not what is wrong with it.
- `change.patch`: the diff under review.
- `truth.json`: the hidden answer. For a defect, its `class`, `file`, `lines`, what it is, and the commit that fixed it. For a control, why it is believed clean.

Each run gets a scratch repository holding the base's tree as one commit, with the patch committed on a card branch. There is no history to read, nothing from this directory inside it, and a card id that is only a position.

The bases are named by commit rather than copied here, so the corpus stays small and old code does not show up in the repository's own searches. It needs a full clone. CI's checkout is shallow, so there the corpus test checks each case's own files but not that its patch applies.

## Where the cases came from

**Defects** are real ones from Wilson's history, not invented. Each started from a merged fix, traced by blame to the commit that introduced the mistake. The patch is that commit without its lockfile changes, and the base is its parent, so the reviewer sees the work as it first arrived. One comment in `defect-merge-check-branch` was reworded to drop an outside reference, which changes no code. Candidates were dropped when the fix depended on code that came later, so the mistake was not yet a mistake, or when the blamed commit only moved code that was already wrong.

**Controls** are merged commits with no sign of a later correction: at least three quarters of their lines survive, and none of the next six commits to their files reads as a fix. That is evidence, not proof. A blocker on a control may be a real find, so read it before counting it against the reviewer.

The `lines` run six lines either side of what the fix changed.

The plans were written for this corpus from the commit messages and diffs, because most of the original cards are gone. A real plan may say more or less than these do.

## Reading the scores

- **Recall** is defect cases with a finding at the defect, over defect cases. It is reported twice: a blocker there, which is what sends work back, and any finding there.
- **Specificity** is controls that passed with no blocker, over controls.
- **Raw** is what the model reported. **Verified** is what the runner would act on: a result `ReviewVerifier` refuses counts as a miss, and a `defect` citing a real file outside the diff counts as the `omission` the verifier treats it as, so its line no longer matters.
- A run that stopped short (engine failure, budget, usage limit, a question, out of steps, no report) says nothing about the review. It is listed and left out of every `n`.

What these numbers cannot say:

- **They stop at review.** A blocker still has to survive challenge, so review-only scores overstate what would reach a kickback.
- **A match is by location only.** A finding on the seeded lines counts even if it describes something else, so read the matched findings before quoting recall.
- **The reviewer had less to go on than a live one.** Scratch repositories have no dependencies installed, so setup, type-check evidence and running tests are all out. Rule judges and learnings need a board and do not run. Unwired-symbol evidence does run.
- **Findings cap at 20.** A review at the cap could not report more, and the report counts how many reached it.
- **`n` is small.** One case moves recall by five points and specificity by ten, so compare runs by the cases that changed. Each case also runs once per run, and a model does not answer the same way twice.

## Adding a case

Add the four files and run the corpus test, which checks that the truth lies on lines the patch adds, the plan gives nothing away, and the patch applies to its base. Then do a dry run. A new case changes what the scores mean, so don't compare across it.
