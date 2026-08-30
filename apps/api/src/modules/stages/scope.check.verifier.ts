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
 * Set at 6, after 5 was tried and refused three cards that were not too large. Every scope-check the
 * board has run reports a group count, and only 0120 (nine) has ever been genuinely oversize. The
 * cards at five — 0024, 0115 and 0046 — were all refused or would have been, and all three were
 * fine: 0024 and 0115 merged cleanly as single cards, and 0046 is the instructive one.
 *
 * 0046 was originally counted as a *reason* to set the line at 5, because it had exhausted the
 * testing stage's step budget three times and been parked. That reasoning was wrong, and it is worth
 * recording why: 0046 never failed for size. It failed because a drag between columns could not be
 * asserted at all under jsdom — dnd-kit measures scrollable ancestors, jsdom returns all-zero rects,
 * and no drop ever resolved. Card 0136 fixed that with a rect-stubbing harness, and 0046's plan did
 * not shrink by a single task. A step-budget overrun is evidence of *something*, but it is not
 * evidence of breadth or depth, and treating it as such put a tooling gap on this constant's ledger.
 *
 * The deeper limit, which no group count can fix: this counts groups, and cohesion is what actually
 * matters. 0120's nine were unrelated subsystems — a migration, a repository, an agent, a registry,
 * a feed, a contract, a route — each needing its own tests. 0046's six are consecutive steps of one
 * gesture in one component. The model told us so, in its own words, and the verifier overrode it:
 * "a single cohesive feature broken into its natural steps, not the same operation applied N times."
 * At 6 that particular disagreement stops happening, but the metric still cannot see the difference,
 * so a genuinely sprawling six-group card will pass. Prefer raising this again over lowering it: the
 * record says depth-shaped overruns are rare and false positives are not.
 *
 * Thirteen cards sit at four groups and twelve of them merged, which is why the line is not drawn
 * lower. Cards 0075 and 0078 — the breadth cases `BREADTH_THRESHOLD` was calibrated against — report
 * a single group each (all the repeated work is one kind, per `ScopeGroupSchema`'s own doc comment)
 * and are unaffected by a depth threshold at any setting.
 */
export const DEPTH_THRESHOLD = 6;

/**
 * How many distinct places a single group's work lands — files, call sites, routes, read from that
 * group's own `sites` (`ScopeGroupSchema`) — it takes before a plan is judged too fanned-out for one
 * pass, no matter how few Tasks-section items describe it.
 *
 * Breadth (`BREADTH_THRESHOLD`) and depth (`DEPTH_THRESHOLD`) both read the plan's Tasks section as
 * written: a task that says "update every internal link" or "migrate every importer of lib/sdk.ts"
 * is one task in one group, however many files it actually touches. Cards 0153, 0155 and 0156 hit
 * exactly this — the model said `refuse` and named the fan-out in its `reason` prose ("roughly 10
 * files" / "~10 nav-rendering files", "14 files that import lib/sdk.ts" / "10 importers of
 * lib/sdk.ts", "~8 route files") — but neither existing threshold could see it, both counted 1 task
 * in 1 group each time, so the refusal was judged unsupported and (before card 0157) forced back to
 * `planning` regardless. Card 0151 is the same shape with no scope-check refusal on record to compare
 * against: a nine-file link migration and a ten-file client rewiring, nine implementing attempts,
 * every failure the step budget.
 *
 * Set at 8 — at or below every figure named above (8, 9, 10, 10, and the disputed 14) — because that
 * is the full extent of the evidence available here. This board's fuller scope-check history (the
 * kind of case-by-case audit `DEPTH_THRESHOLD`'s own comment draws on) lives in Postgres, which this
 * verifier does not query and which this card's own record — the prose quoted above, all this stage
 * can see — is the only evidence available for calibrating this constant against; no broader board
 * audit backs this number the way `DEPTH_THRESHOLD`'s does, and that is recorded here rather than
 * papered over. The two different figures reported for the same lib/sdk.ts case (10 vs. 14) are
 * themselves evidence for why this signal has to be a number and not prose — and a reason to anchor
 * on the lower, more conservative one rather than invent a figure the record does not actually
 * support.
 *
 * Card 0079 is the case this must not catch: 21 Tasks-section bullets, three distinct things each
 * done once. No card on record has ever quoted its per-group site count, so — unlike the catches
 * above — this is not a measured boundary; but nothing in its record describes repetition across
 * sites (the opposite of 0151/0153/0155/0156: each of 0079's three things is done once, not fanned
 * out), so a threshold of 8 is not expected to catch it. If a future scope-check reports otherwise,
 * that is new evidence this comment does not have.
 */
export const FANOUT_THRESHOLD = 8;

const largestGroup = (groups: ScopeGroup[]): ScopeGroup => groups.reduce((max, g) => (g.tasks.length > max.tasks.length ? g : max));
const mostFannedOutGroup = (groups: ScopeGroup[]): ScopeGroup => groups.reduce((max, g) => (g.sites > max.sites ? g : max));

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
 * way it leans — but, as of card 0157, the two directions no longer carry the same consequence. See
 * the last paragraph below.
 *
 * Three signals feed that check, and they catch different shapes. Breadth (`BREADTH_THRESHOLD`, the
 * width of the widest group) catches one kind of work repeated until it will not fit — card 0075's
 * eight near-identical endpoints, card 0078's every-CLI-command port. Depth (`DEPTH_THRESHOLD`, the
 * number of groups) catches many different kinds of work collected into one card, each too small on
 * its own to trip breadth — card 0120's nine one-task groups (schema migration, DB type binding,
 * repository, conversation agent, session registry, SSE feed, service integration, contract
 * declaration, route mounting), which breadth alone let through. Fan-out (`FANOUT_THRESHOLD`, the
 * widest group's own `sites` count) catches the shape breadth and depth both read past: one task
 * whose work actually lands in many files — cards 0153, 0155 and 0156, each a plan the model
 * correctly refused and could only justify in unchecked prose until this signal existed. Card 0079
 * (21 bullets, three distinct things each done once) is the case none of the three may catch: too
 * few groups for depth, no group wide enough for breadth, no group fanned out across enough sites for
 * fan-out.
 *
 * A well-formed "refuse" is this stage doing its job, not a defect in the report — but the routing
 * that actually matters does not read this class's `passed` field at all. `StageDispatcher.runAgent`
 * computes the dispatcher's own `outcome.passed` as `failures.length === 0`, and `shouldAdvance`
 * (`kickback.ts`) only special-cases the literal verdict string `"revise"` (review's own routing
 * signal), not `"refuse"`. Left alone, a well-formed refusal would report zero failures, the
 * dispatcher's `passed` would come out `true`, and the card would advance to `implementing` instead
 * of being kicked back to `planning` — exactly backwards from this stage's whole purpose. So `verify`
 * pushes `refusing: ${reason}` onto `failures` — that is what makes the dispatcher's own
 * `failures.length === 0` check go false and routes the card through `stage.onFail` (`planning`).
 *
 * That push used to be unconditional on `verdict === 'refuse'` alone, and that was a bug (card 0157):
 * it fired even when the consistency check just above had judged the very same refusal unfounded —
 * neither group at `BREADTH_THRESHOLD` nor group count at `DEPTH_THRESHOLD` — so a refusal this stage
 * had itself flagged as unsupported by its own reported evidence was still obeyed, and the card still
 * bounced back to `planning`. Cards 0153, 0155 and 0156 hit exactly this, each a further split of the
 * one before, each blocked on a metric the model had already out-argued: it counted files touched
 * across sites, which `BREADTH_THRESHOLD`/`DEPTH_THRESHOLD` cannot see because they count tasks as
 * written in the plan, not sites touched in the diff — a gap card 0158 closed with `FANOUT_THRESHOLD`,
 * reading each group's own reported `sites` count (`ScopeGroupSchema`) instead of leaving that number
 * stranded in unchecked `reason` prose. The push is now conditioned on the same `tooLarge` the
 * consistency check above already computed: a *supported* refusal (breadth, depth, or fan-out
 * actually met) still pushes and still routes to `planning`, exactly as before. An *unsupported* one
 * pushes nothing, so `failures` can come back empty and the card advances instead. The model's
 * `reason` is not thrown away when that happens — `outcome.result` carries this stage's whole reported
 * result onto the card's event log regardless of `passed`/`failures` (`StageDispatcher.runAgent`), so
 * a human reading the card still finds why the model wanted to refuse.
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
        const mostFannedOut = mostFannedOutGroup(groups);
        const tooBroad = widest.tasks.length >= BREADTH_THRESHOLD;
        const tooDeep = groups.length >= DEPTH_THRESHOLD;
        const tooFannedOut = mostFannedOut.sites >= FANOUT_THRESHOLD;
        const tooLarge = tooBroad || tooDeep || tooFannedOut;

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
            if (tooFannedOut) {
                failures.push(
                    `"${mostFannedOut.title}" lands in ${mostFannedOut.sites} places (>= ${FANOUT_THRESHOLD}), which is what this stage exists to catch, but the verdict is "pass"`,
                );
            }
        }
        // The mirror case — `refuse` with neither signal reported — used to push its own failure here.
        // It no longer does (card 0157): see the comment beside the `refusing: ${reason}` push below,
        // which is where that decision now lives.

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

        if (verdict === 'refuse' && tooLarge) {
            // See the class doc comment: the dispatcher's real routing check is `failures.length ===
            // 0`, not this method's `passed` field, and `shouldAdvance` never special-cases "refuse".
            // Pushed whenever the evidence backs the refusal — even when every check above found
            // nothing else wrong with the report — so a well-founded refusal still fails the
            // dispatcher's check and is kicked back to `planning` instead of advancing to
            // `implementing`.
            failures.push(`refusing: ${reason}`);
        }
        // else (verdict === 'refuse' but !tooLarge): a refusal this stage has itself judged unfounded
        // (card 0157 — cards 0153/0155/0156, each a further split of the one before, hit exactly this).
        // Nothing is pushed here, so this check no longer contributes to the dispatcher's routing and
        // the card is free to advance instead of bouncing back to `planning` on a verdict this stage
        // does not believe. The model's `reason` is not lost: `StageDispatcher` records this stage's
        // whole reported result — `reason` included — on the card's event log whether the stage passes
        // or fails (`outcome.result`, populated from the run's own report independently of `failures`),
        // so a human reading the card still sees why the model wanted to refuse, even though it moved on.

        // `passed` is only ever read by this verifier's own callers, not by the dispatcher's routing
        // (see the class doc comment) — kept `false` for any `refuse`, supported or not: this field
        // tracks whether the verdict was a clean, uncontradicted "pass", not whether the card actually
        // advances, which `failures.length` alone decides. An unfounded refusal above leaves `failures`
        // empty and so does advance, even though it is reported as `passed: false` here.
        return { passed: verdict === 'pass' && failures.length === 0, failures, changedPaths: [] };
    }
}
