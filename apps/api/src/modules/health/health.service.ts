import { Injectable } from 'injectkit';
import { BoardConfig } from '#modules/board/board.config.js';
import { buildHead } from '#src/server/build.info.js';
import type { Health } from '#src/generated/health.js';

/**
 * What the server reports about itself.
 *
 * `head` is the commit captured at boot rather than the repo's HEAD now. Read per request it would
 * report whatever the code repo points at, which is precisely the commit a stale process is *not*
 * running — so the field that exists to expose a stale daemon would hide one.
 */
@Injectable()
export class HealthService {
    constructor(private readonly config: BoardConfig) {}

    get(): Health {
        return { ok: true, project: this.config.project, head: buildHead() };
    }
}
