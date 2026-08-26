import { Injectable } from 'injectkit';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { ScopeCheckResultSchema, type ScopeGroup } from './stage.result.js';
import type { StageVerifier, VerificationInput, VerificationOutcome } from './stage.verifier.js';

/**
 * How many Tasks-section items doing "the same kind of thing" it takes before a plan is judged too
 * broad for one pass.
 *
 * Calibrated against card 0105's measurement of the board (see its Goal/"What the board actually
 * says" sections): card 0075 (eight near-identical write endpoints) and card 0078 (every CLI command
 * ported to a new transport) both cleared this by a wide margin before being caught; card 0079 (21
 * Tasks-section bullets, but three distinct things each done once) never approached it. Set well
 * below eight and well above one, so an ordinary plan with an incidental pair or trio of similar
 * tasks — unremarkable on a 76-card board where this fires for six of them — is not caught by a
 * threshold tuned to the handful of cards that actually blew their step budget.
 */
export const BREADTH_THRESHOLD = 4;

const largestGroup = (groups: ScopeGroup[]): ScopeGroup => groups.reduce((max, g) => (g.tasks.length > max.tasks.length ? g : max));

/**
 * The scope-check stage's exit condition: does the plan fit in one pass.
 *
 * This lane judges, it does not split (card 0105's Goal) — merit (is the card actually too broad) is
 * the model's business, the same division of labor `ReviewVerifier`'s doc comment draws for review
 * findings. What this checks is provenance and internal consistency: does the reported verdict follow
 * from the model's own reported evidence (`groups`), and — when refusing — is the division concrete
 * (at least two pieces, each naming what it delivers alone, each built only from tasks the model
 * itself reported). A model that says "pass" while its own `groups` show an eight-wide repeat, or
 * says "refuse" while reporting none, has produced an inconsistent report regardless of which way it
 * leans, and this stage's whole value is in not passing that through uncaught.
 *
 * Unlike `ReviewVerifier`, whose `passed` tracks report quality independently of the verdict
 * (`shouldAdvance` resolves the routing from `verdict` afterwards), `passed` here *is* the routing
 * decision: see the doc comment on `ScopeCheckResultSchema` for why that is this stage's exit
 * condition rather than a shortcut around one.
 */
@Injectable()
export class ScopeCheckVerifier implements StageVerifier {
    constructor(private readonly worktrees: WorktreeManager) {}

    async verify({ worktree, result }: VerificationInput): Promise<VerificationOutcome> {
        const failures: string[] = [];

        // `worktree: readonly` is this stage's own config, not something the write tool alone can be
        // trusted to have enforced end to end (a command run through the bash tool could still have
        // touched the tree) — the same reasoning `ReviewVerifier` applies to "a reviewer does not
        // edit". Checked before the parse below so a stage that both wrote files and returned a
        // malformed result gets both failures rather than only the first one found.
        const written = await this.worktrees.uncommittedPaths(worktree);
        if (written.length > 0) {
            failures.push(`the scope-check stage changed files, which a read-only judge must not do: ${written.join(', ')}`);
        }

        const parsed = ScopeCheckResultSchema.safeParse(result);
        if (!parsed.success) {
            failures.push(`the reported result does not match the scope-check schema: ${parsed.error.message}`);
            return { passed: false, failures, changedPaths: [] };
        }

        const { verdict, groups, division, reason } = parsed.data;

        if (reason.trim().length === 0) {
            failures.push('reason is empty: a verdict with no stated reason gives "planning" nothing to start from');
        }

        const widest = largestGroup(groups);
        const tooBroad = widest.tasks.length >= BREADTH_THRESHOLD;

        if (tooBroad && verdict !== 'refuse') {
            failures.push(
                `"${widest.title}" repeats across ${widest.tasks.length} tasks (>= ${BREADTH_THRESHOLD}), which is what this stage exists to catch, but the verdict is "pass"`,
            );
        }
        if (!tooBroad && verdict === 'refuse') {
            failures.push(
                `verdict is "refuse" but no group repeats ${BREADTH_THRESHOLD} or more times (widest: "${widest.title}" x${widest.tasks.length}) — breadth is this stage's signal, and none was reported`,
            );
        }

        if (verdict === 'refuse') {
            // A division is only real if it is built from work the model actually reported seeing.
            // Not full-coverage checked (a piece is free to leave shared plumbing ungrouped) — only
            // that nothing it names is invented.
            const namedTasks = new Set(groups.flatMap(g => g.tasks));
            for (const piece of division) {
                for (const task of piece.tasks) {
                    if (!namedTasks.has(task)) {
                        failures.push(`division piece "${piece.title}" cites task "${task}", which is not among the reported groups`);
                    }
                }
                if (piece.delivers.trim().length === 0) {
                    failures.push(`division piece "${piece.title}" does not say what it would deliver on its own`);
                }
            }
        } else if (division.length > 0) {
            failures.push('verdict is "pass" but a division was proposed; a pass should carry none');
        }

        // `passed` is the routing decision itself (see the class doc comment): only a well-formed,
        // internally consistent "pass" clears this stage's exit condition. A well-formed "refuse" is
        // this stage doing its job correctly, and still reports `failures: []` — but it is not a
        // `passed` outcome, because passing here means "send the card to implementing", which a
        // refusal must never do.
        return { passed: verdict === 'pass' && failures.length === 0, failures, changedPaths: [] };
    }
}
