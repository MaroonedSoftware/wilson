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

/**
 * How many distinct groups — how many different *kinds* of work, each counted once no matter how
 * many tasks it holds — it takes before a plan is judged too deep for one pass.
 *
 * Breadth (`BREADTH_THRESHOLD`) catches one kind of work repeated until it will not fit; this catches
 * the opposite shape — many different kinds of work collected into one card, each small enough on its
 * own that breadth never fires. Card 0120 is the case that motivated it: nine groups (schema
 * migration, DB type binding, repository, conversation agent, session registry, SSE feed, service
 * integration, contract declaration, route mounting), each of size one, so `largestGroup` never came
 * close to `BREADTH_THRESHOLD` — and the card went on to produce 812 insertions across 14 files and
 * exhaust the testing stage's step budget three times over. A depth threshold of 9 or below would have
 * caught it. Card 0079 is the case it must not catch: 21 Tasks-section bullets that are "three distinct
 * things each done once" — three groups — the lane's own doc comment names this as the false positive
 * to avoid, so the threshold must clear 3.
 *
 * Set at 5, and what that costs is on the record rather than left to the two easy cases above. Every
 * scope-check the board has run reports a group count; sorted, exactly four cards reach 5 or more.
 * 0120 (nine) is the true positive. 0046 (five) is the other one worth catching — it also exhausted
 * the testing stage's step budget three times and was parked unfinished. The remaining two, 0024 and
 * 0115 (five each), **merged cleanly as single cards** and would now be refused and sent back to
 * `planning` to be split for nothing. That is the trade this number makes, deliberately: a needless
 * split costs one planning round, a missed oversize card costs three testing passes and a human, so
 * two false positives are worth catching 0046. A threshold of 6 would take only 0120 and spare all
 * three — choose that instead if the wrongful splits ever start outnumbering the catches. Thirteen
 * cards sit at four groups and twelve of them merged, which is why the line is not drawn lower.
 *
 * Cards 0075 and 0078 — the breadth cases `BREADTH_THRESHOLD` was calibrated against — report a single
 * group each (all the repeated work is one kind, per `ScopeGroupSchema`'s own doc comment) and are
 * unaffected by a depth threshold at any setting.
 */
export const DEPTH_THRESHOLD = 5;

const largestGroup = (groups: ScopeGroup[]): ScopeGroup => groups.reduce((max, g) => (g.tasks.length > max.tasks.length ? g : max));

/**
 * The scope-check stage's exit condition: does the plan fit in one pass.
 *
 * This lane judges, it does not split (card 0105's Goal) — merit (is the card actually too large) is
 * the model's business, the same division of labor `ReviewVerifier`'s doc comment draws for review
 * findings. What this checks is provenance and internal consistency: does the reported verdict follow
 * from the model's own reported evidence (`groups`), and — when refusing — is the division concrete
 * (at least two pieces, each naming what it delivers alone and what it depends on, each built only
 * from tasks — and citing only dependencies on other pieces — the model itself reported). A model
 * that says "pass" while its own `groups` show an eight-wide repeat, or nine groups of different work,
 * or says "refuse" while reporting neither, has produced an inconsistent report regardless of which
 * way it leans, and this stage's whole value is in not passing that through uncaught.
 *
 * Two signals feed that check, and they catch different shapes. Breadth (`BREADTH_THRESHOLD`, the
 * width of the widest group) catches one kind of work repeated until it will not fit — card 0075's
 * eight near-identical endpoints, card 0078's every-CLI-command port. Depth (`DEPTH_THRESHOLD`, the
 * number of groups) catches many different kinds of work collected into one card, each too small on
 * its own to trip breadth — card 0120's nine one-task groups (schema migration, DB type binding,
 * repository, conversation agent, session registry, SSE feed, service integration, contract
 * declaration, route mounting), which breadth alone let through. Card 0079 (21 bullets, three distinct
 * things each done once) is the case neither signal may catch: too few groups for depth, no group wide
 * enough for breadth.
 *
 * A well-formed "refuse" is this stage doing its job, not a defect in the report — but the routing
 * that actually matters does not read this class's `passed` field at all. `StageDispatcher.runAgent`
 * computes the dispatcher's own `outcome.passed` as `failures.length === 0`, and `shouldAdvance`
 * (`kickback.ts`) only special-cases the literal verdict string `"revise"` (review's own routing
 * signal), not `"refuse"`. Left alone, a well-formed refusal would report zero failures, the
 * dispatcher's `passed` would come out `true`, and the card would advance to `implementing` instead
 * of being kicked back to `planning` — exactly backwards from this stage's whole purpose. So `verify`
 * pushes an entry onto `failures` whenever `verdict === 'refuse'`, unconditionally on whether the
 * report was otherwise internally consistent: that is what makes the dispatcher's own
 * `failures.length === 0` check go false and routes the card through `stage.onFail` (`planning`).
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
        const tooDeep = groups.length >= DEPTH_THRESHOLD;
        const tooLarge = tooBroad || tooDeep;

        if (tooLarge && verdict !== 'refuse') {
            if (tooBroad) {
                failures.push(
                    `"${widest.title}" repeats across ${widest.tasks.length} tasks (>= ${BREADTH_THRESHOLD}), which is what this stage exists to catch, but the verdict is "pass"`,
                );
            }
            if (tooDeep) {
                failures.push(
                    `the plan reports ${groups.length} distinct groups (>= ${DEPTH_THRESHOLD}) — many different kinds of work collected into one card, which is what this stage exists to catch, but the verdict is "pass"`,
                );
            }
        }
        if (!tooLarge && verdict === 'refuse') {
            failures.push(
                `verdict is "refuse" but no group repeats ${BREADTH_THRESHOLD} or more times (widest: "${widest.title}" x${widest.tasks.length}) and only ${groups.length} distinct groups were reported (< ${DEPTH_THRESHOLD}) — neither breadth nor depth is this stage's signal, and neither was reported`,
            );
        }

        if (verdict === 'refuse') {
            // A division is only real if it is built from work the model actually reported seeing.
            // Not full-coverage checked (a piece is free to leave shared plumbing ungrouped) — only
            // that nothing it names is invented.
            const namedTasks = new Set(groups.flatMap(g => g.tasks));
            const pieceTitles = new Set(division.map(p => p.title));
            for (const piece of division) {
                for (const task of piece.tasks) {
                    if (!namedTasks.has(task)) {
                        failures.push(`division piece "${piece.title}" cites task "${task}", which is not among the reported groups`);
                    }
                }
                if (piece.delivers.trim().length === 0) {
                    failures.push(`division piece "${piece.title}" does not say what it would deliver on its own`);
                }
                // Same provenance reasoning as `tasks` above, applied to the third thing a division
                // must name (card 0105's Constraints: "what depends on what") — a dependency is only
                // real if it points at another piece this same division actually proposed.
                for (const dep of piece.dependsOn) {
                    if (dep === piece.title) {
                        failures.push(`division piece "${piece.title}" lists itself as a dependency`);
                    } else if (!pieceTitles.has(dep)) {
                        failures.push(`division piece "${piece.title}" depends on "${dep}", which is not one of this division's own pieces`);
                    }
                }
            }
        } else if (division.length > 0) {
            failures.push('verdict is "pass" but a division was proposed; a pass should carry none');
        }

        if (verdict === 'refuse') {
            // See the class doc comment: the dispatcher's real routing check is `failures.length ===
            // 0`, not this method's `passed` field, and `shouldAdvance` never special-cases "refuse".
            // Pushed unconditionally — even when every check above found nothing wrong with the
            // report — so a well-formed refusal still fails the dispatcher's check and is kicked back
            // to `planning` instead of advancing to `implementing`.
            failures.push(`refusing: ${reason}`);
        }

        // `passed` is only ever read by this verifier's own callers, not by the dispatcher's routing
        // (see the class doc comment) — kept `false` for a refusal for the same reason: passing here
        // would mean "send the card to implementing", which a refusal must never do.
        return { passed: verdict === 'pass' && failures.length === 0, failures, changedPaths: [] };
    }
}
