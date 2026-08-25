import { Injectable } from 'injectkit';
import { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import { buildHead } from '#src/server/build.info.js';
import type { Health } from '#src/generated/health.js';

/**
 * Captured once, when this module is first loaded — which happens while the process is still
 * bootstrapping, before it can serve a request. Read live it would report the current time on every
 * call instead of when the process actually started, which is the only question `startedAt` exists
 * to answer.
 */
const startedAt = DateTime.utc();

/**
 * What the server reports about itself.
 *
 * `head` is the commit captured at boot rather than the repo's HEAD now. Read per request it would
 * report whatever the code repo points at, which is precisely the commit a stale process is *not*
 * running — so the field that exists to expose a stale daemon would hide one. `startedAt` is the
 * same idea applied to time: card 0079's "daemon not stale" check compares it against the working
 * tree's HEAD commit time to answer "is this process older than the fix on disk" by asking, not by
 * grepping a process table for a command line that assumed there was only ever one daemon.
 */
@Injectable()
export class HealthService {
    constructor(private readonly config: BoardConfig) {}

    get(): Health {
        return { ok: true, project: this.config.project, head: buildHead(), startedAt };
    }
}
