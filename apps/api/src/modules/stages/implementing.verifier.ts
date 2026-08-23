import { Injectable } from 'injectkit';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { WorktreeManager, type Worktree } from '#modules/worktree/worktree.manager.js';
import { runConfiguredCommand } from './run.command.js';
import type { StageConfig } from './stage.config.js';

export interface VerificationInput {
    worktree: Worktree;
    scope: ScopeGuard;
    stage: StageConfig;
}

/**
 * The implementing stage's exit condition, in order, all three required.
 *
 * Every exit condition an agent can satisfy by doing less work is one it will eventually satisfy by
 * doing less work (PROJECT.md). `build passes` on its own is satisfied by an empty diff, so the diff
 * must be non-empty; and a non-empty diff on its own says nothing about *where* it landed, so every
 * changed path is re-checked against scope.
 *
 * The scope re-check is not redundant with the write tool. The tool stops the writes it sees; this
 * catches anything that reached the tree another way — a file moved by an allowlisted command, or a
 * build step that wrote outside its lane.
 */
@Injectable()
export class ImplementingVerifier {
    constructor(private readonly worktrees: WorktreeManager) {}

    async verify({ worktree, scope, stage }: VerificationInput): Promise<{ passed: boolean; failures: string[]; changedPaths: string[] }> {
        const failures: string[] = [];
        const changedPaths = await this.worktrees.changedPaths(worktree);

        if (changedPaths.length === 0) {
            failures.push('the diff is empty: the stage changed nothing');
        }

        for (const path of changedPaths) {
            const decision = await scope.check(path);
            if (!decision.allowed) {
                failures.push(`${path} is outside the plan’s files in scope (${decision.reason})`);
            }
        }

        if (stage.buildCommand) {
            const build = await runConfiguredCommand(worktree.path, stage.buildCommand);
            if (build) failures.push(build.reason);
        }

        return { passed: failures.length === 0, failures, changedPaths };
    }
}
