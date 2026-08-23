import { Injectable } from 'injectkit';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { runConfiguredCommand } from './run.command.js';
import type { StageVerifier, VerificationInput, VerificationOutcome } from './stage.verifier.js';

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
export class ImplementingVerifier implements StageVerifier {
    constructor(private readonly worktrees: WorktreeManager) {}

    async verify({ worktree, scope, stage }: VerificationInput): Promise<VerificationOutcome> {
        const failures: string[] = [];
        const changedPaths = await this.worktrees.changedPaths(worktree);

        // What *this stage* wrote, as opposed to what the card has changed. A stage only commits on
        // pass, so at verification time its own work is exactly the uncommitted set.
        const written = await this.worktrees.uncommittedPaths(worktree);

        if (written.length === 0) {
            failures.push('the diff is empty: the stage changed nothing');
        }

        // Scope is judged against this stage's own writes, never the card's whole diff. `changedPaths`
        // measures from the fork point, so on a resumed branch it carries every earlier stage's work
        // — and a later stage is entitled to files an earlier one's scope excludes. Card 0014 kicked
        // back from testing to implementing and then failed three times on test files the testing
        // stage had every right to add, escalating to needs-human over a rule rather than the work.
        for (const path of written) {
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
