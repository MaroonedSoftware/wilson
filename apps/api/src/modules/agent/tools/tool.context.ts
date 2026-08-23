import type { Logger } from '@maroonedsoftware/logger';
import type { EventLog } from '#modules/events/event.log.js';
import type { CommandAllowlist } from '../command.allowlist.js';
import type { ScopeGuard } from '../scope.guard.js';

export type ScopeViolationPolicy = 'widen' | 'kickback';

/**
 * Everything the tools are allowed to touch.
 *
 * Deliberately narrow: the tools get a worktree path, the two guards, and somewhere to log. They
 * have no database handle, no board access, and no credentials — the agent's blast radius is this
 * object (PROJECT.md, Agent sandbox).
 */
export interface ToolContext {
    project: string;
    cardId: string;
    stage: string;
    worktreeRoot: string;
    scope: ScopeGuard;
    commands: CommandAllowlist;
    scopeViolationPolicy: ScopeViolationPolicy;
    events: EventLog;
    logger: Logger;
}

/** Raised when `request_scope` is refused under the `kickback` policy, to fail the stage. */
export class ScopeKickbackError extends Error {
    constructor(
        readonly requestedPath: string,
        readonly requestReason: string,
    ) {
        super(`stage requested scope for ${requestedPath} and the project policy is kickback: ${requestReason}`);
    }
}
