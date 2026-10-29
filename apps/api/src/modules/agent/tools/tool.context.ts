import type { Logger } from '@maroonedsoftware/logger';
import type { EventLog } from '#modules/events/event.log.js';
import type { ExecutionHost } from '#modules/host/execution.host.js';
import { localHost } from '#modules/host/local.execution.host.js';
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
    /**
     * The dev server port `StageDispatcher` allocated for this stage's worktree (card 0027), read by
     * `bash.tool.ts` and handed to `scrubbedEnv` so a dev server the agent starts sees the same
     * `PORT` a `setupCommand` run would. Undefined whenever the stage has no worktree or no port
     * range is configured — the default, and the only case most stages are in.
     */
    port?: number;
    /**
     * The machine `worktreeRoot` is on, which every tool reads, writes and runs commands through.
     * Read it with `toolHost`, never directly. Optional for the same reason `StageDispatcher`'s
     * `settings` is: the suite builds this object by hand in dozens of places, and every one of them
     * means this machine. `StageDispatcher.runAgent` always sets it.
     */
    host?: ExecutionHost;
}

/** The host a tool's work goes through: the context's own, or this machine when it names none. */
export const toolHost = (ctx: ToolContext): ExecutionHost => ctx.host ?? localHost;

/** Raised when `request_scope` is refused under the `kickback` policy, to fail the stage. */
export class ScopeKickbackError extends Error {
    constructor(
        readonly requestedPath: string,
        readonly requestReason: string,
    ) {
        super(`stage requested scope for ${requestedPath} and the project policy is kickback: ${requestReason}`);
    }
}
