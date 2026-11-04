import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { PROVIDERS } from '#modules/agent/model.registry.js';
import { DONE, DONE_REASONS } from './terminal.js';

/**
 * The longest a single stage run may be configured to take.
 *
 * A job carries far more than the agent: cutting the worktree, `pnpm install`, the run itself,
 * verification and the transition all happen inside one `card.stage` job. The queue expires a job
 * that outlives `CARD_STAGE_EXPIRES_IN` and hands it to another worker, so a stage whose wall clock
 * approaches that figure produces a second agent on the same branch. This cap leaves the difference
 * as headroom for everything around the run.
 */
export const MAX_STAGE_WALL_CLOCK_MS = 3_000_000;

/**
 * How long a stage may produce nothing before it is abandoned, unless it says otherwise.
 *
 * Capped at the stage's own wall clock when that is shorter, so a stage with a tight time budget
 * does not carry an idle window it can never reach.
 */
const DEFAULT_IDLE_MS = 300_000;

/** What `CLAUDE_CODE_AUTO_COMPACT_WINDOW` can hold: the engine moves anything outside this range to its edge. */
const AutoCompactWindow = z.number().int().min(100_000).max(1_000_000);

/**
 * How far below its window the engine compacts: 20k kept for output and a 13k buffer. Read from the
 * engine on 2.1.317, where a model allowing under 20k of output would keep less. Recheck on an upgrade.
 */
const ENGINE_COMPACT_MARGIN = 33_000;

/**
 * Whether `maxContextWindowFraction` would stop a run before the engine got to compact it, which would
 * leave a lane's `autoCompactWindow` doing nothing but failing runs. `getContextUsage` rounds its
 * percentage, so the guard fires half a point early: at 0.9 the crossover is near 314k, not 330k.
 */
const contextGuardBeatsCompaction = (autoCompactWindow: number, maxContextWindowFraction: number): boolean =>
    (maxContextWindowFraction - 0.005) * autoCompactWindow <= autoCompactWindow - ENGINE_COMPACT_MARGIN;

/**
 * A run inside a lane that is not the lane's own: its own prompt, verifier and budgets, on the lane's
 * provider, model and routes, with the card staying in the lane throughout. `on` says when it runs:
 * `revise` when the lane's run reports `verdict: revise`, `approve` when a person approves a plan.
 *
 * Anything it does not name is the lane's. There are no defaults here, on purpose: a default would
 * silently replace the value the lane chose.
 */
export const LaneStepSchema = z.object({
    name: z.string(),
    on: z.enum(['approve', 'revise']),
    instructions: z.string(),
    /** Defaults to the step's name. */
    verifier: z.string().optional(),
    mode: z.enum(['agent', 'command', 'manual']).optional(),
    worktree: z.enum(['none', 'readonly', 'rw']).optional(),
    worktreeFrom: z.enum(['base', 'branch']).optional(),
    placement: z.enum(['local', 'any', 'remote']).optional(),
    tools: z.array(z.string()).optional(),
    allowedCommands: z.array(z.string()).optional(),
    extraScope: z.array(z.string()).optional(),
    setupCommand: z.string().optional(),
    buildCommand: z.string().optional(),
    maxSteps: z.number().int().min(1).optional(),
    maxOutputTokens: z.number().int().min(1024).optional(),
    maxInputTokens: z.number().int().min(1000).optional(),
    maxWallClockMs: z.number().int().min(1000).max(MAX_STAGE_WALL_CLOCK_MS).optional(),
    maxBudgetUsd: z.number().positive().optional(),
    autoCompactWindow: AutoCompactWindow.optional(),
});

export type LaneStep = z.infer<typeof LaneStepSchema>;

/** The step a lane runs on `on`, if it has one. */
export const stepOn = (stages: ProjectStages, lane: string, on: LaneStep['on']): LaneStep | undefined =>
    stages.stages.find(stage => stage.name === lane)?.steps?.find(step => step.on === on);

/** The plan check a stage is, resolved by `findStage`, or undefined for any other run. */
export const isPlanCheck = (stage: StageConfig): boolean => stage.steps?.some(step => step.name === stage.step && step.on === 'approve') ?? false;

/**
 * Whether a lane reaches a model. `planning` is manual, since the queue never dispatches it, but its
 * session runs on the lane's model.
 */
export const runsModel = (stage: { name: string; mode: string }): boolean => stage.mode === 'agent' || stage.name === 'planning';

/**
 * Whether a lane's routing can be set. `ready` is here but not in `runsModel`: its review workspace
 * runs the chat engine's model until the lane names one, so it can have a model without needing one.
 */
export const canRoute = (stage: { name: string; mode: string }): boolean => runsModel(stage) || stage.name === 'ready';

/**
 * Stages are config, not code (PROJECT.md decision 8).
 *
 * Only `implementing` is configured today, but the shape is the full one — mode, worktree
 * requirement, routing, budget, targets — so adding the testing stage as card one is a config edit
 * plus a verifier, not a change to the dispatcher.
 */
export const StageConfigSchema = z
    .object({
        name: z.string(),
        mode: z.enum(['agent', 'command', 'manual']),
        worktree: z.enum(['none', 'readonly', 'rw']).default('rw'),
        /**
         * Which engine runs this stage.
         *
         * `api` drives the AI SDK against a provider key and bills per token. `cli` drives the Claude
         * Code engine from the operator's own credentials — no key, no per-token billing. They fail
         * independently, which is the point: an exhausted API balance leaves `cli` working. `codex`
         * drives OpenAI's Codex engine, and runs only a stage marked `isolated`.
         */
        adapter: z.enum(['api', 'cli', 'codex']).default('api'),
        provider: z.enum(PROVIDERS).default('anthropic'),
        /** Required on a lane that runs a model (`runsModel`). Any other lane has none to name. */
        model: z.string().optional(),
        /** System guidance for the stage. The plan itself is passed as a file path, never inlined. */
        instructions: z.string(),
        /** Tool names this stage may use. Omit for all of them. */
        tools: z.array(z.string()).optional(),
        /** Commands the bash tool will run for this stage, as argv prefixes. */
        allowedCommands: z.array(z.string()).default([]),
        /**
         * Where this stage's worktree comes from.
         *
         * `base` cuts fresh from HEAD — right for the first stage of a card, where every attempt starts
         * clean. `branch` re-opens the card's existing branch, which every later stage needs: the
         * testing stage works on the tree implementing produced.
         */
        worktreeFrom: z.enum(['base', 'branch']).default('base'),
        /**
         * Which machine the stage runs on: `local` (this one, the default and the only choice before
         * hosts existed), `any` (a registered host when one can run it, waiting for a slot when they
         * are only busy, and this machine when none can), or `remote` (a registered host only; with
         * none free, the dispatch is deferred until one is).
         *
         * A host is used only when it is enabled, not draining, serves the card's project, passed its last
         * probe, and will not expire before the stage's `maxWallClockMs` is up. A stage with
         * `worktree: none` has no tree to place and always runs here.
         */
        placement: z.enum(['local', 'any', 'remote']).default('local'),
        /**
         * Runs only on a host an operator has vouched for as isolated (`wilson host isolated`), for a
         * stage whose engine cannot be relied on to keep it inside its worktree. Needs `placement:
         * remote` and a worktree, since this machine is never isolated: everything here is within reach.
         */
        isolated: z.boolean().optional(),
        /**
         * Whether commands in a `codex` stage's sandbox may use the network, which includes a database
         * on localhost. That sandbox has no allowlist of hosts, so it is all or nothing, and off unless
         * set. Ignored by every other adapter.
         */
        networkAccess: z.boolean().optional(),
        /**
         * Globs this stage may write on top of the card's own "Files in scope".
         *
         * A card's scope is written for the stage that implements it. The testing stage's whole job is
         * to add files nobody could have declared in advance, so it carries its own.
         */
        extraScope: z.array(z.string()).default([]),
        /**
         * Override of `ProjectStagesSchema`'s project-wide `scopeViolation`, for this stage alone.
         *
         * Absent means "use the project's value" — a board that sets nothing new here behaves exactly as
         * it does today. A stage that must not widen its own scope (`implementing`, after card 0154) sets
         * `kickback` here without forcing every other stage's ordinary widening (`testing`'s scratch
         * files) to become a kickback too. Same enum as the project-wide field, resolved at
         * `stage.dispatcher.ts` alongside it — the stage's own value wins when present.
         */
        scopeViolation: z.enum(['widen', 'kickback']).optional(),
        /**
         * Override of the project-wide `sandbox.enabled` (`ProjectStagesSchema`, below), for this stage
         * alone — same "stage's own value wins when present" pattern as `scopeViolation` above. Absent
         * means "use the project's value". `findStage` resolves the two into this very field, to a plain
         * `boolean`, so a caller reading a stage found through it never needs the project's own
         * `ProjectStages` on the side — in particular `cli.stage.agent.ts` (card 0260's other file in
         * scope), which only ever sees the one `StageConfig` this function returns.
         *
         * Off by default everywhere: a project that never sets `sandbox` anywhere resolves every stage's
         * `sandbox` to `false`, and `cli.stage.agent.ts`'s `query()` call stays exactly what it is today.
         * Card 0256 is why a boundary matters at all, beyond this project's own tool guard: on some
         * engine builds a tool call can reach the process without the guard ever being consulted, and an
         * OS-level sandbox bounds the process regardless of why the guard was skipped.
         */
        sandbox: z.boolean().optional(),
        /**
         * The project's `sandbox.allowedDomains` (`ProjectStagesSchema`, below), copied onto every stage
         * by `findStage`. There is no per-stage override for the domain list itself — only for whether
         * sandboxing is on at all (`sandbox`, above) — so this is never meaningfully authored on a
         * stage's own config; `findStage` overwrites it from the project-wide block on every load, the
         * same way it already does for `verifier`. Read by `cli.stage.agent.ts`, which needs the
         * project's configured domains but, like `sandbox` above, never sees the project's own
         * `ProjectStages` to read them from directly.
         */
        sandboxAllowedDomains: z.array(z.string()).default([]),
        /**
         * Run once at worktree creation, before the agent starts.
         *
         * A fresh worktree has no node_modules, and without this the agent spends its budget installing
         * dependencies and confirming the baseline builds instead of doing the card.
         */
        setupCommand: z.string().optional(),
        /** The command whose exit code the exit condition checks. */
        buildCommand: z.string().optional(),
        /**
         * On a lane that reviews: the type checker to run on the branch and on its base before the agent
         * starts, so the reviewer's plan lists the errors the branch adds. Evidence only, it fails nothing.
         * It must not write outside ignored files, and it needs `setupCommand` if it needs dependencies.
         * Under turbo pass `--continue`, or the first failing package cancels the rest and the two lists
         * stop being comparable.
         */
        typecheckCommand: z.string().optional(),
        /**
         * The command whose exit code the exit condition checks for formatting.
         *
         * Check, not write: a formatter that reformats a stage's files on its way out would hide the
         * drift it exists to catch, and would change the diff the rest of verification is judging.
         * Same shape as `buildCommand` — only the exit code matters, and the tool's own output is what
         * a failure reports.
         */
        formatCommand: z.string().optional(),
        /** The command that runs the test suite and writes the report `testReportPath` points at. */
        testCommand: z.string().optional(),
        /** Where the test report lands, relative to the worktree. */
        testReportPath: z.string().optional(),
        /**
         * Whether the testing verifier should run the pre-change baseline: a second worktree, cut from
         * the same base, that proves this card's new tests fail before the change. Defaults on; the
         * escape hatch exists for stages where a baseline run cannot be completed at all rather than for
         * saving time (PROJECT.md decision on exit conditions that can be satisfied by doing less work).
         */
        baselineCheck: z.boolean().default(true),
        /**
         * Whether the testing verifier compares a card's TS/JS test files with their base, failing a
         * net drop in assertions or a new `expect(true).toBe(true)`. Needs no baseline run, so it does
         * not go off with `baselineCheck`. A card with a good reason declares it in its plan
         * (`Expected assertion drop: N (reason)`) rather than a lane turning this off.
         */
        assertionCheck: z.boolean().default(true),
        /** Name of the registered verifier to run at the exit condition. Defaults to the stage's own name. */
        verifier: z.string().optional(),
        maxSteps: z.number().int().min(1).default(60),
        maxOutputTokens: z.number().int().min(1024).default(16000),
        /**
         * Cost-weighted input tokens a single run may consume before it is cut off as a budget failure
         * (`budgetedInputTokens`: fresh input at 1, cache reads at 0.1, cache writes at 1.25). Every turn
         * resends the conversation, mostly as cache reads, so this grows far more slowly than the raw
         * tokens stats show. The default is meant to catch a runaway, not to shape an ordinary run.
         */
        maxInputTokens: z.number().int().min(1000).default(15_000_000),
        /**
         * Fraction of the model's context window a run's usage may reach before it is stopped as a
         * budget failure.
         *
         * Distinct from `maxInputTokens`, worth stating plainly: that one bounds the cost-weighted input
         * tokens a run has already spent across every turn so far. This bounds the request the *next*
         * turn is about to build on top of what the context window already holds — a run can be well
         * under its token budget and still overflow on a single turn, because a turn's prompt carries
         * the whole conversation so far, tools and memory files included, not just what that one turn
         * spends. Compared against `Query.getContextUsage()`'s own `percentage` (`cli.stage.agent.ts`)
         * rather than derived from token counts — the api adapter has no equivalent and is out of scope.
         * That percentage is of the window the engine resolves, which is `autoCompactWindow` when set
         * and otherwise the engine's choice for the model, with nothing taken off for compaction. So on
         * a window of about 315k or more, 0.9 stops the run before the engine ever compacts: the engine
         * compacts 33k below the window, which on those is above 90% of it. 0.9 is otherwise a turn's
         * worth of headroom, rather than stopping exactly at the edge, which would be one turn too late.
         */
        maxContextWindowFraction: z.number().gt(0).max(1).default(0.9),
        /**
         * The context window the `cli` engine compacts against, in tokens, passed to it as
         * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Unset leaves it to the engine. A smaller window makes each
         * resent turn cheaper, at the cost of a summary: the engine compacts at about this minus 33k, so
         * a window of 140k compacts near 107k (`stage.compacted` records each one). No other adapter
         * reads it. Rejected where `maxContextWindowFraction` would stop the run first.
         */
        autoCompactWindow: AutoCompactWindow.optional(),
        /**
     * Wall-clock a single run may take before it is aborted as a budget failure.
     *
     * Capped at `MAX_STAGE_WALL_CLOCK_MS`, because a stage that can outlive the job carrying it gets
     * that job redelivered while the first attempt is still running — two agents in one worktree, on
     " one branch. Rejecting the config is the only place that can be caught before it happens.
     */
        maxWallClockMs: z.number().int().min(1000).max(MAX_STAGE_WALL_CLOCK_MS).default(1_800_000),
        /**
         * The longest the engine may produce nothing at all before the run is abandoned.
         *
         * Silence, not duration: `maxWallClockMs` already bounds a stage that is working too slowly, and
         * this bounds one that is not working at all. Card 0052's engine exited without emitting a
         * `result`, leaving the adapter reading a stream that would never close — and because the
         * wall-clock abort could not break that read either, the only thing that recovered the card was
         * the queue expiring the job 62 minutes later, spending one of its three retries on a run that
         * produced nothing.
         *
         * The default has to clear the longest *legitimate* silence, which is a single tool call: the
         * engine emits no message between requesting a tool and reporting its result, so a full test run
         * is minutes of honest quiet. Five minutes is roughly an order of magnitude above the model
         * turnaround these stages see and still an order of magnitude below the queue's hour. Erring
         * long is cheap; erring short kills working stages.
         *
         * Optional rather than defaulted, because the default has to know `maxWallClockMs`: a stage that
         * legitimately sets a one-minute wall clock must not inherit a five-minute idle window it can
         * never reach. Resolved below, where both are in hand.
         */
        maxIdleMs: z.number().int().min(1000).optional(),
        /** Dollar ceiling passed to the `cli` engine, which tracks cost itself. Unset means no ceiling. */
        maxBudgetUsd: z.number().positive().optional(),
        /**
         * Ceiling on everything a card has ever spent, across every stage and every attempt.
         *
         * Unlike `maxInputTokens`, which bounds one run, this bounds the card, and counts the same
         * way, cost-weighted. It sits on the stage
         * rather than the card because that is where every other budget lives, and a project sets it
         * once across its stages. Optional: absent means unbounded, exactly as today.
         */
        maxCardInputTokens: z.number().int().min(1000).optional(),
        /** Where a passing run sends the card. */
        onPass: z.string(),
        /**
         * Where a failing run sends the card.
         *
         * The target is the stage that can fix the failure — not automatically the stage before this
         * one. `review.onFail: implementing` is correct: a review blocker is a statement about the
         * code, so the code is what changes. Routing every failure to the previous stage assumes that
         * is always true, and it is not: when `testing` fails its own exit condition — it wrote no
         * tests, or its report predates the run it was supposed to come from — `implementing` has
         * nothing left to redo.
         *
         * Card 0060 hit this the expensive way: `testing.onFail: implementing` sent a passing,
         * already-committed implementation to a stage with an empty diff to produce; the implementing
         * verifier correctly rejected that, `implementing.onFail: implementing` sent it back to itself,
         * and it burned its remaining `maxKickbacks` rediscovering that it had already finished — three
         * worktrees and three agent runs to arrive at `needsHuman` on a card whose work was correct the
         * whole time.
         *
         * A self-targeting `onFail` (`testing.onFail: testing`) is not a special case here. It retries
         * bounded by the stage's own `maxKickbacks`, exactly like a kickback to any other stage — the
         * difference is only that the stage still has real work left to do (write the missing tests),
         * so a retry can actually change the outcome instead of reproducing the same empty diff.
         *
         * That "real work left to do" assumption has a limit: testing can fail not because it skipped
         * its own job but because the implementation it was handed cannot be tested as written — no
         * seam to attach an assertion to, a dependency nothing can fake, behavior only a code change
         * could make observable. A self-loop retrying `testing` does not fix that; no amount of trying
         * harder writes a passing test for something that cannot be tested. The self-loop does not lose
         * this case silently, though — it still runs out `maxKickbacks` and lands on `needsHuman`,
         * exactly like any other exhausted stage, carrying a reason string built from testing's own
         * failed attempts. A human reading that reason alongside the worktree can tell "wrote no tests"
         * apart from "this cannot be tested as built" and route the latter to `implementing` by hand
         * (`wilson card move`). What the self-loop costs in that case is not a wrong answer, only a
         * later one: `maxKickbacks` worth of testing attempts before a human sees it, instead of routing
         * straight there. Distinguishing the two automatically would need a signal `kickback` does not
         * have today — a structured reason from the failed run itself, not just which stage failed and
         * how many times — see the note in `kickback.ts`. Left for a later card rather than guessed at
         * here.
         */
        onFail: z.string(),
        maxKickbacks: z.number().int().min(0).default(3),
        /** Runs inside this lane that are not its own (`LaneStepSchema`). */
        steps: z.array(LaneStepSchema).optional(),
        /** Which of `steps` this is, set only by `findStage` when it resolves one. */
        step: z.string().optional(),
    })
    .superRefine((stage, ctx) => {
        if (runsModel(stage) && !stage.model) {
            ctx.addIssue({ code: 'custom', path: ['model'], message: `${stage.name} runs a model, so it needs one` });
        }
        if (stage.isolated && stage.placement !== 'remote') {
            ctx.addIssue({
                code: 'custom',
                path: ['isolated'],
                message: `an isolated stage must have placement: remote, not ${stage.placement}, since this machine is not isolated`,
            });
        }
        if (stage.isolated && stage.worktree === 'none') {
            ctx.addIssue({
                code: 'custom',
                path: ['isolated'],
                message: 'an isolated stage needs a worktree: with worktree: none it would run on this machine',
            });
        }
        // Only an *explicit* value is rejected. An idle window at or above the wall clock can never
        // fire first, which is dead config that reads like a working guard — the same class of
        // mistake `assertRoutesResolve` exists to catch for routes. The resolved default below can
        // never be in that state, so it is not worth failing a config over.
        if (stage.maxIdleMs !== undefined && stage.maxIdleMs >= stage.maxWallClockMs) {
            ctx.addIssue({
                code: 'custom',
                path: ['maxIdleMs'],
                message: `maxIdleMs (${stage.maxIdleMs}) must be below maxWallClockMs (${stage.maxWallClockMs}), or the idle guard can never fire`,
            });
        }
        const windows = [
            { path: ['autoCompactWindow'], label: stage.name, window: stage.autoCompactWindow },
            ...(stage.steps ?? []).map((step, index) => ({
                path: ['steps', index, 'autoCompactWindow'],
                label: `step ${step.name}`,
                window: step.autoCompactWindow,
            })),
        ];
        for (const { path, label, window } of windows) {
            if (window !== undefined && contextGuardBeatsCompaction(window, stage.maxContextWindowFraction)) {
                ctx.addIssue({
                    code: 'custom',
                    path,
                    message: `${label}: autoCompactWindow ${window} compacts at about ${window - ENGINE_COMPACT_MARGIN}, but maxContextWindowFraction ${stage.maxContextWindowFraction} stops the run first. Lower one of them`,
                });
            }
        }
    })
    .transform(stage => ({ ...stage, maxIdleMs: stage.maxIdleMs ?? Math.min(DEFAULT_IDLE_MS, stage.maxWallClockMs) }));

export type StageConfig = z.infer<typeof StageConfigSchema>;

export const ProjectStagesSchema = z.object({
    /** Project-wide default. A stage's own `scopeViolation` (`StageConfigSchema`) overrides this. */
    scopeViolation: z.enum(['widen', 'kickback']).default('widen'),
    /** Machine-owned paths no plan should have to mention. */
    alwaysAllowed: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    /**
     * Project-wide sandbox default (card 0260). `enabled` turns on the SDK's own OS-level sandbox
     * for the `cli` engine's `query()` call in `cli.stage.agent.ts` — filesystem and network limits
     * enforced by the OS underneath this project's own tool guard, not instead of it. Card 0256 is
     * why that matters: on some engine builds a tool call can skip the guard's own consultation
     * entirely, and a sandbox bounds the process regardless of why the guard was skipped.
     *
     * A stage's own `sandbox` (`StageConfigSchema`, above) overrides `enabled` alone, exactly as a
     * stage's own `scopeViolation` overrides this schema's — there is no per-stage override for
     * `allowedDomains`; every sandboxed stage in the project shares the one list.
     *
     * Off, with no domains, until an operator turns it on for a stage they have measured
     * (`wilson stages set` — this card does not touch the live config). Strict, unlike the rest of
     * this schema's own blocks: an unrecognised key here is almost certainly a typo for one of the
     * two real ones, and failing config validation loudly beats silently doing nothing with it.
     */
    sandbox: z
        .object({
            enabled: z.boolean().default(false),
            allowedDomains: z.array(z.string()).default([]),
        })
        .strict()
        .default({ enabled: false, allowedDomains: [] }),
    stages: z.array(StageConfigSchema),
});

export type ProjectStages = z.infer<typeof ProjectStagesSchema>;

/**
 * Which "never" a `StageConfigError` describes.
 *
 * `stage-not-found` (`findStage`) is deterministic for the job that named the stage and no action on
 * that job changes it — retrying is pointless, but so is leaving it queued, so it poisons.
 * `config-invalid` covers every way the stage config itself is missing or malformed (no row for the
 * project, fails schema validation, or routes to a state that does not exist): that is not a fact
 * about any one card, it is true for every card that would load this config, so poisoning each as it
 * arrives would turn one config typo into a board full of poisoned cards a human then walks back one
 * at a time. Those defer instead, leaving the card exactly where it is until the config is fixed.
 *
 * A field rather than a subclass, matching `NotDispatchableError`'s `reason` — see
 * `classifyDispatchFailure` for how `CardStageJob` branches on it ahead of `isPermanentFailure`'s
 * message matching, which is tuned for provider errors that carry no type of their own, not this
 * codebase's own.
 */
export type StageConfigErrorKind = 'stage-not-found' | 'config-invalid';

export class StageConfigError extends Error {
    constructor(
        public readonly kind: StageConfigErrorKind,
        message: string,
    ) {
        super(message);
        this.name = 'StageConfigError';
    }
}

/**
 * Recursively freeze a parsed config so every caller can share one object.
 *
 * `StageConfigStore`'s cache hands the same instance to every caller, where each call used to return
 * its own fresh parse. No caller mutates what it gets back today (`findStage` even returns a copy
 * rather than the stage it found), so this changes nothing that happens now — it makes that a
 * property of the value rather than a convention every future caller has to be told about, which is
 * the difference between a shared object being safe and it being safe so far.
 */
const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
};

/** The part of a lane that says what runs it, set on its own (`wilson stages route`). */
export type StageRouting = Pick<StageConfig, 'adapter' | 'provider'> & { model: string };

/** A lane's model, for code about to run it. Schema validation means only a misrouted caller can see this throw. */
export const modelOf = (stage: StageConfig): string => {
    if (!stage.model) throw new StageConfigError('config-invalid', `${stage.name} has no model`);
    return stage.model;
};

/**
 * Refuse routing a stage's engine cannot honour, in the operator's own terms.
 *
 * The `cli` engine and the planning session always run Claude, so any other provider there would
 * save happily and then be ignored. Checked on a routing write and not in the schema: a document
 * that already says this has been harmless so far, and failing to load it would stop the board.
 * `isolated` is what the stage's document says, since a `codex` stage has to be marked so.
 */
export const assertRoutable = (stage: string, routing: StageRouting, isolated?: boolean): void => {
    if (!routing.model.trim()) {
        throw new StageConfigError('config-invalid', 'a model is required');
    }
    const session = { planning: 'the planning session', ready: 'the review workspace' }[stage];
    if (routing.adapter === 'codex') {
        if (session) throw new StageConfigError('config-invalid', `${session} always runs Claude, so it cannot use the codex adapter`);
        if (routing.provider !== 'openai')
            throw new StageConfigError('config-invalid', `the codex adapter always runs OpenAI, so ${stage} cannot use provider ${routing.provider}`);
        if (!isolated)
            throw new StageConfigError('config-invalid', `${stage} must be marked isolated in its stage config before it can use the codex adapter`);
    }
    if (routing.provider !== 'anthropic' && (routing.adapter === 'cli' || session)) {
        throw new StageConfigError(
            'config-invalid',
            `${session ?? 'the cli adapter'} always runs Claude, so ${stage} cannot use provider ${routing.provider}`,
        );
    }
};

/**
 * Lay each stage's routing over the document, before validation.
 *
 * Before, not after, so a row passes through the same schema a document's own values do, and a stage
 * with neither fails the same way a document missing `model` always has. A row for a stage the
 * document no longer has is left unused: it is history, and is live again if that stage comes back.
 */
export const applyRouting = (document: unknown, routing: ReadonlyMap<string, StageRouting>): unknown => {
    if (routing.size === 0 || typeof document !== 'object' || document === null) return document;
    const { stages } = document as { stages?: unknown };
    if (!Array.isArray(stages)) return document;
    return {
        ...document,
        stages: stages.map(stage => {
            const row = routing.get((stage as { name?: string } | null)?.name ?? '');
            return row ? { ...stage, ...row } : stage;
        }),
    };
};

/**
 * Parse and validate one stage config document, as an import reads one and a test writes one. Pure, so
 * a test can hand it a string. `source` names the document in any refusal, and `routing` holds routing
 * by stage, each one winning over the document's own values.
 */
export const parseStages = (raw: string, source = 'stage config', routing: ReadonlyMap<string, StageRouting> = new Map()): ProjectStages => {
    let document: unknown;
    try {
        document = parseYaml(raw);
    } catch (err) {
        throw new StageConfigError('config-invalid', `${source} is not valid YAML: ${(err as Error).message}`);
    }

    return validateStages(applyRouting(document, routing), source);
};

/** Validate an already-read config, wherever it was read from: the checks every load has to pass. */
export const validateStages = (document: unknown, source = 'stage config'): ProjectStages => {
    const parsed = ProjectStagesSchema.safeParse(document);
    if (!parsed.success) {
        throw new StageConfigError(
            'config-invalid',
            `${source} is not valid stage config: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
    }

    assertRoutesResolve(parsed.data, source);

    return deepFreeze(parsed.data);
};

/**
 * Every on-pass and on-fail target must name a configured stage or a terminal state.
 *
 * A route to somewhere that does not exist strands the card silently: the transition is written, the
 * card lands in a state nothing dispatches, and nothing reports a problem. Card 0011 found this the
 * expensive way — its implementing stage failed, was kicked back to `planning` exactly as configured,
 * and `planning` is not a stage anyone has built yet.
 */
export const assertRoutesResolve = (stages: ProjectStages, path = 'stage config'): void => {
    const known = new Set<string>([...NON_STAGE_STATES, ...DONE_REASONS, ...stages.stages.map(s => s.name)]);

    const dangling = stages.stages.flatMap(stage =>
        (['onPass', 'onFail'] as const).filter(key => !known.has(stage[key])).map(key => `${stage.name}.${key} → "${stage[key]}"`),
    );

    if (dangling.length > 0) {
        throw new StageConfigError(
            'config-invalid',
            `${path} routes to states that do not exist: ${dangling.join(', ')}. Valid targets: ${[...known].sort().join(', ')}.`,
        );
    }
};

/**
 * States a card may occupy that are not agent stages.
 *
 * `done` ends a card's life and nothing dispatches it, so it has no stage config (PROJECT.md, Stage
 * model). `parking-lot` is a column the dispatch query excludes.
 */
export const NON_STAGE_STATES = ['parking-lot', DONE] as const;

/**
 * Every state a card may legitimately be moved to.
 *
 * A stage the graph names as an on-pass or on-fail target counts even before anything implements
 * it: that is precisely the state of a half-built pipeline, and refusing it would mean a card that
 * passed `implementing` had nowhere to go.
 */
export const validTargets = (stages: ProjectStages): string[] => {
    const targets = new Set<string>([...NON_STAGE_STATES, ...DONE_REASONS]);
    for (const stage of stages.stages) {
        targets.add(stage.name);
        targets.add(stage.onPass);
        targets.add(stage.onFail);
    }
    return [...targets].sort();
};

export const findStage = (stages: ProjectStages, name: string, stepName?: string): StageConfig => {
    const stage = stages.stages.find(s => s.name === name);
    if (!stage) {
        throw new StageConfigError(
            'stage-not-found',
            `no stage named "${name}" in the stage config (have: ${stages.stages.map(s => s.name).join(', ')})`,
        );
    }
    const lane: StageConfig = {
        ...stage,
        verifier: stage.verifier ?? stage.name,
        // Card 0260: the stage's own `sandbox` wins when set, otherwise the project-wide default
        // applies — resolved here, not at `stage.dispatcher.ts` the way `scopeViolation` is, because
        // `cli.stage.agent.ts` (this card's other file in scope) only ever receives the one
        // `StageConfig` this function returns, never the `stages: ProjectStages` this call took in.
        sandbox: stage.sandbox ?? stages.sandbox.enabled,
        sandboxAllowedDomains: stages.sandbox.allowedDomains,
    };
    if (stepName === undefined) return lane;

    const step = stage.steps?.find(candidate => candidate.name === stepName);
    if (!step) throw new StageConfigError('stage-not-found', `lane "${name}" has no step named "${stepName}"`);

    const { name: _name, on: _on, ...fields } = step;
    // The planning session runs on the `cli` engine whatever its lane says (`assertRoutable`), so a
    // step of that lane does too: one provider and model, one engine and one bill.
    const adapter = name === 'planning' ? 'cli' : lane.adapter;
    const maxWallClockMs = fields.maxWallClockMs ?? lane.maxWallClockMs;
    return {
        ...lane,
        ...fields,
        adapter,
        mode: fields.mode ?? 'agent',
        step: step.name,
        verifier: step.verifier ?? step.name,
        maxWallClockMs,
        maxIdleMs: Math.min(lane.maxIdleMs, maxWallClockMs),
    };
};
