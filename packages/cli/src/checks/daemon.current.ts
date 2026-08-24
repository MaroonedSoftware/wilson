import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Check } from '@maroonedsoftware/johnny5';

const exec = promisify(execFile);

/**
 * A running daemon must not predate the code it is running.
 *
 * Node loads its modules once, so a daemon started before a fix carries on running the code from
 * before it. Card 0014 failed three times against a scope bug that had been fixed on disk half an
 * hour earlier, and the failures were indistinguishable from the bug still being there — the same
 * error, on the same files, from a build nobody could see.
 *
 * PROJECT.md's Bootstrapping section already required this: the daemon runs from an installed build,
 * and redeploying is a deliberate act between cards. This makes forgetting visible.
 */
export const daemonCurrent: Check = {
    name: 'daemon not stale',
    run: async ctx => {
        const root = ctx.config.get('PROJECT_CODE_ROOT', '');
        if (!root) return { ok: true, message: 'PROJECT_CODE_ROOT not set; skipped' };

        const running = await exec('pgrep', ['-f', 'index.ts run']).catch(() => undefined);
        const pid = running?.stdout.trim().split('\n').filter(Boolean)[0];
        if (!pid) return { ok: true, message: 'no daemon running' };

        const started = await exec('ps', ['-p', pid, '-o', 'lstart=']).catch(() => undefined);
        if (!started) return { ok: true, message: `daemon ${pid} running; start time unavailable` };

        const startedAt = new Date(started.stdout.trim());
        const head = await exec('git', ['log', '-1', '--format=%cI'], { cwd: root }).catch(() => undefined);
        if (!head) return { ok: true, message: `daemon ${pid} running` };

        const headAt = new Date(head.stdout.trim());
        if (headAt > startedAt) {
            return {
                ok: false,
                message: `daemon ${pid} started ${startedAt.toISOString()}, but HEAD landed ${headAt.toISOString()}`,
                fixHint:
                    'Restart it. A daemon started before the current HEAD is running code you cannot see, and its failures look exactly like the bugs you already fixed.',
            };
        }

        return { ok: true, message: `daemon ${pid} is current` };
    },
};
