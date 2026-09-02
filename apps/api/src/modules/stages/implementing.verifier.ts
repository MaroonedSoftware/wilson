import { Injectable } from 'injectkit';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { runConfiguredCommand } from './run.command.js';
import { checkFormat, type StageVerifier, type VerificationInput, type VerificationOutcome } from './stage.verifier.js';

/**
 * The implementing stage's exit condition, in order, all four required.
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
            // Card 0182, decided 2026-09-02: the rule stands, the message tells the two cases apart.
            // "Did nothing" and "nothing left to do" both leave this set empty, and the difference is
            // already in hand — `changedPaths` measures from the fork point, so on a branch that
            // already carries this card's work it is non-empty while `written` is not. That happens
            // when a plan is corrected mid-flight (card 0171) or when a stage was landed by hand. The
            // verdict is the same either way; what changes is whether the operator is told to look at
            // the agent or at the board.
            failures.push(
                changedPaths.length > 0
                    ? `this stage wrote nothing, and the branch already carries ${changedPaths.length} file(s) of this card's work. If that work is done, move the card to the stage that still has work rather than re-running this one — an already-finished stage cannot satisfy a rule that exists to stop an agent doing less (card 0182).`
                    : 'the diff is empty: the stage changed nothing',
            );
        }

        // Scope is judged against this stage's own writes, never the card's whole diff. `changedPaths`
        // measures from the fork point, so on a resumed branch it carries every earlier stage's work
        // — and a later stage is entitled to files an earlier one's scope excludes. Card 0014 kicked
        // back from testing to implementing and then failed three times on test files the testing
        // stage had every right to add, flagging the card for a human over a rule rather than the work.
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

        // Formatting is an exit condition, not a habit an agent is asked to remember: this is a
        // fact the machinery checks, not prose in the instructions hoping it happens.
        failures.push(...(await checkFormat(worktree, stage)));

        return { passed: failures.length === 0, failures, changedPaths };
    }
}
