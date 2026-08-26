import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { PROVIDERS } from '#modules/agent/model.registry.js';

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

/**
 * Stages are config, not code (PROJECT.md decision 8).
 *
 * Only `implementing` is configured today, but the shape is the full one — mode, worktree
 * requirement, routing, budget, targets — so adding the testing stage as card one is a config edit
 * plus a verifier, not a change to the dispatcher.
 */
export const StageConfigSchema = z.object({
    name: z.string(),
    mode: z.enum(['agent', 'command', 'manual']),
    worktree: z.enum(['none', 'readonly', 'rw']).default('rw'),
    /**
     * Which engine runs this stage.
     *
     * `api` drives the AI SDK against a provider key and bills per token. `cli` drives the Claude
     * Code engine from the operator's own credentials — no key, no per-token billing. They fail
     * independently, which is the point: an exhausted API balance leaves `cli` working.
     */
    adapter: z.enum(['api', 'cli']).default('api'),
    provider: z.enum(PROVIDERS).default('anthropic'),
    model: z.string(),
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
     * Globs this stage may write on top of the card's own "Files in scope".
     *
     * A card's scope is written for the stage that implements it. The testing stage's whole job is
     * to add files nobody could have declared in advance, so it carries its own.
     */
    extraScope: z.array(z.string()).default([]),
    /**
     * Run once at worktree creation, before the agent starts.
     *
     * A fresh worktree has no node_modules, and without this the agent spends its budget installing
     * dependencies and confirming the baseline builds instead of doing the card.
     */
    setupCommand: z.string().optional(),
    /** The command whose exit code the exit condition checks. */
    buildCommand: z.string().optional(),
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
    /** Name of the registered verifier to run at the exit condition. Defaults to the stage's own name. */
    verifier: z.string().optional(),
    maxSteps: z.number().int().min(1).default(60),
    maxOutputTokens: z.number().int().min(1024).default(16000),
    /** Cumulative input tokens a single run may consume before it is cut off as a budget failure. */
    maxInputTokens: z.number().int().min(1000).default(2_000_000),
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
     * Unlike `maxInputTokens`, which bounds one run, this bounds the card. It sits on the stage
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
})
    .superRefine((stage, ctx) => {
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
    })
    .transform(stage => ({ ...stage, maxIdleMs: stage.maxIdleMs ?? Math.min(DEFAULT_IDLE_MS, stage.maxWallClockMs) }));

export type StageConfig = z.infer<typeof StageConfigSchema>;

export const ProjectStagesSchema = z.object({
    scopeViolation: z.enum(['widen', 'kickback']).default('widen'),
    /** Machine-owned paths no plan should have to mention. */
    alwaysAllowed: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    stages: z.array(StageConfigSchema),
});

export type ProjectStages = z.infer<typeof ProjectStagesSchema>;

/**
 * Which "never" a `StageConfigError` describes.
 *
 * `stage-not-found` (`findStage`) is deterministic for the job that named the stage and no action on
 * that job changes it — retrying is pointless, but so is leaving it queued, so it poisons.
 * `config-invalid` covers every way `stages.yaml` itself is missing or malformed (unreadable, fails
 * schema validation, or routes to a state that does not exist): that is not a fact about any one card,
 * it is true for every card that would load this file, so poisoning each as it arrives would turn one
 * config typo into a board full of poisoned cards a human then walks back one at a time. Those defer
 * instead, leaving the card exactly where it is until the file is fixed.
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
 * The last successfully loaded config per `stages.yaml` path, with the file identity it was read at.
 *
 * `loadStages` is on every dispatch twice over — `StageDispatcher.run` and `CardStageJob.runStage`
 * each call it for the same file — plus every poller tick and several API routes, and each call was
 * a read, a YAML parse, a zod validation and a route check for a file that changes when a human
 * edits it and at no other time. The `stat` that replaces all of that is one syscall.
 *
 * Only successful loads are stored: an unreadable or invalid config must keep throwing on every
 * call, since the operator fixing it is exactly the case that needs the next call to see the fix.
 */
interface LoadedStages {
    mtimeMs: number;
    size: number;
    value: ProjectStages;
}

const loaded = new Map<string, LoadedStages>();

/**
 * Recursively freeze a parsed config so every caller can share one object.
 *
 * The cache hands the same instance to every caller, where each call used to return its own fresh
 * parse. No caller mutates what it gets back today (`findStage` even returns a copy rather than the
 * stage it found), so this changes nothing that happens now — it makes that a property of the value
 * rather than a convention every future caller has to be told about, which is the difference between
 * a shared object being safe and it being safe so far.
 */
const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
};

/**
 * Load `config/stages.yaml` from the board repo.
 *
 * Stage config lives on the board, not in the code repo, and the write tool denies it — an agent
 * that can edit its own exit condition passes every time (PROJECT.md decision 9).
 *
 * Reads through a `stat`-guarded cache (`loaded`, above). "Stages are config, not code" (PROJECT.md
 * decision 7) means an operator edits this file on a running daemon and expects the next dispatch to
 * see it, so the guard is the file's own mtime and size rather than a timeout: any editor's save
 * moves mtime, and the next call re-reads. The stat is taken *before* the read and stored as-is, so
 * a write landing between the two is recorded under the older identity and simply misses next call —
 * an extra read, never a stale answer. Storing the post-read stat would invert that and could pin
 * pre-write content under a post-write identity indefinitely.
 */
export const loadStages = async (boardRoot: string): Promise<ProjectStages> => {
    const path = join(boardRoot, 'config', 'stages.yaml');

    const stats = await stat(path).catch(() => undefined);
    if (stats) {
        const cached = loaded.get(path);
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.value;
    }

    const raw = await readFile(path, 'utf8').catch((err: Error) => err);
    if (raw instanceof Error) {
        throw new StageConfigError('config-invalid', `could not read ${path}: ${raw.message}`);
    }

    const parsed = ProjectStagesSchema.safeParse(parseYaml(raw));
    if (!parsed.success) {
        throw new StageConfigError(
            'config-invalid',
            `${path} is not valid stage config: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
    }

    assertRoutesResolve(parsed.data, path);

    const value = deepFreeze(parsed.data);
    if (stats) loaded.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, value });
    return value;
};

/**
 * Every on-pass and on-fail target must name a configured stage or a terminal state.
 *
 * A route to somewhere that does not exist strands the card silently: the transition is written, the
 * card lands in a state nothing dispatches, and nothing reports a problem. Card 0011 found this the
 * expensive way — its implementing stage failed, was kicked back to `planning` exactly as configured,
 * and `planning` is not a stage anyone has built yet.
 */
export const assertRoutesResolve = (stages: ProjectStages, path = 'stages.yaml'): void => {
    const known = new Set<string>([...NON_STAGE_STATES, ...stages.stages.map(s => s.name)]);

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
 * Terminal states end a card's life and nothing dispatches them, so they have no stage config
 * (PROJECT.md, Stage model). `parking-lot` is a column the dispatch query excludes.
 */
export const NON_STAGE_STATES = ['parking-lot', 'merged', 'poisoned', 'dropped'] as const;

/**
 * Every state a card may legitimately be moved to.
 *
 * A stage the graph names as an on-pass or on-fail target counts even before anything implements
 * it: that is precisely the state of a half-built pipeline, and refusing it would mean a card that
 * passed `implementing` had nowhere to go.
 */
export const validTargets = (stages: ProjectStages): string[] => {
    const targets = new Set<string>(NON_STAGE_STATES);
    for (const stage of stages.stages) {
        targets.add(stage.name);
        targets.add(stage.onPass);
        targets.add(stage.onFail);
    }
    return [...targets].sort();
};

export const findStage = (stages: ProjectStages, name: string): StageConfig => {
    const stage = stages.stages.find(s => s.name === name);
    if (!stage) {
        throw new StageConfigError(
            'stage-not-found',
            `no stage named "${name}" in stages.yaml (have: ${stages.stages.map(s => s.name).join(', ')})`,
        );
    }
    return { ...stage, verifier: stage.verifier ?? stage.name };
};
