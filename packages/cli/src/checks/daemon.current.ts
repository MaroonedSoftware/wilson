import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Check } from '@maroonedsoftware/johnny5';
import { DateTime } from 'luxon';
import { apiClient } from '../api-client.js';

const exec = promisify(execFile);

/**
 * A running daemon must not predate the code it is running.
 *
 * Node loads its modules once, so a daemon started before a fix carries on running the code from
 * before it. Card 0014 failed three times against a scope bug that had been fixed on disk half an
 * hour earlier, and the failures were indistinguishable from the bug still being there — the same
 * error, on the same files, from a build nobody could see.
 *
 * The API is the daemon (card 0079) — there is one process that can drain the queue, and it can
 * report its own start time over `GET /api/health`. Asking it is both more accurate than a `pgrep`
 * for a process's command line — which went blind the moment the API itself became a second
 * entrypoint that could drain the queue — and it works from anywhere the API is reachable, not only
 * on the box it happens to run on.
 *
 * PROJECT.md's Bootstrapping section already required this: the daemon runs from an installed build,
 * and redeploying is a deliberate act between cards. This makes forgetting visible.
 *
 * Card 0100: this is now the manual view of a check the runner also makes on its own, automatically,
 * at the moment staleness actually matters — the instant before it dispatches a stage, in
 * `CardStageJob.checkDaemonCurrent` (`apps/api/src/modules/jobs/card.stage.job.ts`). Nothing here
 * runs unless a human happens to run `wilson doctor`; that check runs on every dispatch, which is
 * why it exists rather than this one being taught to run more often. The two do not share an
 * implementation — this one asks over HTTP, from outside the process, whether the daemon's start
 * time trails the code repo's HEAD commit time; the runner asks from inside the process, by commit
 * ancestry, whether the daemon's own commit is behind the exact commit the card's worktree is about
 * to be cut from (`HealthService.commitsBehind`) — but both exist to answer the same question, so a
 * change to what "stale" means on one side is worth checking against the other.
 */
export const daemonCurrent: Check = {
    name: 'daemon not stale',
    run: async ctx => {
        const root = ctx.config.get('PROJECT_CODE_ROOT', '');
        if (!root) return { ok: true, message: 'PROJECT_CODE_ROOT not set; skipped' };

        // Unreachable means no daemon — a legitimate, passing state, not this check's business to
        // flag. Any other failure to answer is treated the same way: this check exists to catch a
        // daemon running stale code, not to diagnose the API itself — other checks already do that.
        const health = await apiClient(ctx)
            .health.getHealth()
            .catch(() => undefined);
        if (!health) return { ok: true, message: 'no daemon running' };

        const startedAt = DateTime.fromISO(health.startedAt);
        const head = await exec('git', ['log', '-1', '--format=%cI'], { cwd: root }).catch(() => undefined);
        if (!head) return { ok: true, message: `daemon running (${health.project}), started ${startedAt.toISO()}; HEAD unavailable` };

        const headAt = DateTime.fromISO(head.stdout.trim());
        if (headAt > startedAt) {
            return {
                ok: false,
                message: `daemon started ${startedAt.toISO()}, but HEAD landed ${headAt.toISO()}`,
                fixHint:
                    'Restart it. A daemon started before the current HEAD is running code you cannot see, and its failures look exactly like the bugs you already fixed.',
            };
        }

        return { ok: true, message: `daemon is current (${health.project}), started ${startedAt.toISO()}` };
    },
};
