import { DateTime } from 'luxon';
const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

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
 * generated from [Health](../../../../apps/api/data/contracts/health.ck)
 */
export interface Health {
    ok: boolean;
    project: string;
    head: string;
    startedAt: DateTime;
    codeRoot: string;
    worktreeRoot: string;
}

/** Rehydrates every wire-encoded scalar in a Health into its runtime type. Mutates and returns `raw`. */
export function reviveHealth(raw: Health): Health {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['startedAt'] = __dt(__o0['startedAt'], 'Health.startedAt');
    return raw;
}
