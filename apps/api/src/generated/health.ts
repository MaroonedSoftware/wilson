import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * What the server says about itself. `head` is the commit captured at boot, not the repo's current
 * HEAD: this project lost three runs to a daemon quietly serving code from before a fix, and a field
 * read per request would report the new commit and make exactly that daemon look current.
 *
 * `startedAt` is the other half of that same question, captured the same way: when this process came
 * up. `wilson doctor`'s "daemon not stale" check (card 0079) asks this endpoint rather than grepping
 * for a process, so a stale API is detectable by anyone who can reach it, not just by shelling into
 * the host it runs on.
 *
 * `codeRoot` and `worktreeRoot` are deployment topology (card 0106) — read-only
 * wherever they are shown, since changing them out from under a running daemon is not a setting,
 * it is a redeploy. They live here rather than in `settings.ck` for exactly that reason.
 * generated from [Health](../../data/contracts/health.ck)
 */
export const Health = z.strictObject({
    ok: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    project: z.string(),
    head: z.string(),
    startedAt: _ZodDatetime,
    codeRoot: z.string(),
    worktreeRoot: z.string(),
});
export type Health = z.infer<typeof Health>;
