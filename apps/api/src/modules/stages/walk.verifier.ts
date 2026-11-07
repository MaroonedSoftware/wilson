import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { z } from 'zod';
import { worktreeHost, WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { ReviewFindingSchema } from './stage.result.js';
import type { StageVerifier, VerificationInput, VerificationOutcome } from './stage.verifier.js';

export const WalkStepSchema = z.object({
    action: z.string().min(1).describe('What you did, as a user would: "opened /cards/0001", "clicked Send answer".'),
    expected: z.string().min(1).describe('What a user should see after it, from the plan.'),
    observed: z.string().min(1).describe('What you actually saw, from the running app: the text, the status, the error.'),
    ok: z.boolean(),
});

/**
 * What the walk step reports: the user's path it walked through the running app, step by step, and a
 * verdict. `revise` is a walk that did not deliver what the plan promised, and sends the card back with
 * its blockers like a review's `revise`. `not-tested` is a walk that could not be done (no screen, no
 * way to start the app here), which is never a pass: it says why, and the card goes on with that said.
 */
export const WalkResultSchema = z.object({
    summary: z.string(),
    path: z.string().min(1).describe('The path a user takes through the change, start to finish, that you walked.'),
    steps: z.array(WalkStepSchema).min(1),
    verdict: z.enum(['pass', 'revise', 'not-tested']),
    findings: z.array(ReviewFindingSchema).max(20).default([]),
    notTested: z.string().optional().describe('With verdict "not-tested": which steps nobody ran, and why.'),
    difficulty: z.string().optional().describe('Optional. One line on what slowed you down, if anything did.'),
});

export type WalkResult = z.infer<typeof WalkResultSchema>;

/**
 * The walk step's exit condition. Like the review's, it judges the report's consistency and provenance,
 * never its merit: the walker changed no files; a `pass` has every step ok and no blocker; a `revise`
 * has a step that failed and a blocker saying what to fix, naming a file that exists; a `not-tested`
 * says why and leaves a finding so the person at the gate reads it.
 */
@Injectable()
export class WalkVerifier implements StageVerifier {
    constructor(private readonly worktrees: WorktreeManager) {}

    async verify({ worktree, result }: VerificationInput): Promise<VerificationOutcome> {
        const failures: string[] = [];
        const changedPaths = await this.worktrees.changedPaths(worktree);
        const written = await this.worktrees.uncommittedPaths(worktree);
        if (written.length > 0) failures.push(`the walk changed files, which it must not do: ${written.join(', ')}`);

        const parsed = WalkResultSchema.safeParse(result);
        if (!parsed.success) {
            failures.push(`the reported result does not match the walk schema: ${parsed.error.message}`);
            return { passed: false, failures, changedPaths, reportRejected: true };
        }
        const { verdict, steps, findings, notTested } = parsed.data;
        const failedStep = steps.some(step => !step.ok);
        const blockers = findings.filter(finding => finding.severity === 'blocker');

        if (verdict === 'pass' && failedStep) failures.push('verdict is "pass" but a step of the walk is not ok');
        if (verdict !== 'revise' && blockers.length > 0) failures.push(`verdict is "${verdict}" but a finding is a blocker`);
        if (verdict === 'revise' && !failedStep) failures.push('verdict is "revise" but every step of the walk is ok');
        if (verdict === 'revise' && blockers.length === 0) failures.push('verdict is "revise" but no finding is a blocker saying what to fix');
        if (verdict === 'not-tested' && !notTested?.trim())
            failures.push('verdict is "not-tested" but `notTested` does not say what nobody ran, and why');
        if (verdict === 'not-tested' && findings.length === 0)
            failures.push('verdict is "not-tested" but no finding tells the person at the gate what was not tested');

        const host = worktreeHost(worktree);
        for (const finding of findings) {
            const exists = await host.readFile(join(worktree.path, finding.file)).then(
                () => true,
                () => false,
            );
            if (!exists) failures.push(`finding cites ${finding.file}, which does not exist in the worktree`);
        }

        return {
            passed: failures.length === 0,
            failures,
            changedPaths,
            ...(failures.length > 0 && written.length === 0 ? { reportRejected: true } : {}),
        };
    }
}
