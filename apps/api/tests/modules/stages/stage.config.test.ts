import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
    assertRoutable,
    StageConfigSchema,
    ProjectStagesSchema,
    MAX_STAGE_WALL_CLOCK_MS,
    findStage,
    parseStages,
} from '#modules/stages/stage.config.js';
import { CARD_STAGE_EXPIRES_IN } from '#modules/jobs/jobs.module.js';

/**
 * Card 0015 added budget caps to the stage schema: `maxInputTokens`, `maxWallClockMs` and
 * `maxBudgetUsd`. Nothing bounded input tokens or wall-clock before this card.
 */
const minimalStage = {
    name: 'implementing',
    mode: 'agent' as const,
    model: 'claude-opus',
    instructions: 'do the thing',
    onPass: 'review',
    onFail: 'implementing',
};

describe('StageConfigSchema isolated', () => {
    it('is off by default', () => {
        expect(StageConfigSchema.parse(minimalStage).isolated).toBeUndefined();
    });

    it('allows a remote stage with a worktree', () => {
        expect(StageConfigSchema.parse({ ...minimalStage, isolated: true, placement: 'remote' }).isolated).toBe(true);
    });

    it.each(['local', 'any'])('refuses placement: %s, either of which could run it on this machine', placement => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, isolated: true, placement })).toThrow(/placement: remote/);
    });

    it('refuses worktree: none, which always runs on this machine', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, isolated: true, placement: 'remote', worktree: 'none' })).toThrow(/needs a worktree/);
    });
});

describe('StageConfigSchema budget fields', () => {
    it('defaults maxInputTokens to 15,000,000 when omitted', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.maxInputTokens).toBe(15_000_000);
    });

    it('defaults maxWallClockMs to 1,800,000 (30 minutes) when omitted', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.maxWallClockMs).toBe(1_800_000);
    });

    it('leaves maxBudgetUsd unset when omitted, rather than defaulting it', () => {
        // Cost in currency is not a thing the `api` adapter tracks — tokens are its unit. `cli` is
        // the only engine that can enforce a dollar ceiling, so an unset value must mean "no
        // ceiling", not "zero".
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.maxBudgetUsd).toBeUndefined();
    });

    it('defaults the idle window below the wall clock, so a tight time budget does not carry an unreachable guard', () => {
        const tight = StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: 60_000 });
        expect(tight.maxIdleMs).toBe(60_000);

        const roomy = StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: 1_800_000 });
        expect(roomy.maxIdleMs).toBe(300_000);
    });

    it('refuses an explicit idle window that can never fire before the wall clock', () => {
        // Dead config that reads like a working guard, which is the failure worth catching.
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: 60_000, maxIdleMs: 60_000 })).toThrow(/maxIdleMs/);
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: 60_000, maxIdleMs: 90_000 })).toThrow(/maxIdleMs/);
    });

    it('accepts an explicit maxInputTokens, maxWallClockMs and maxBudgetUsd', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, maxInputTokens: 500_000, maxWallClockMs: 60_000, maxBudgetUsd: 5 });
        expect(stage.maxInputTokens).toBe(500_000);
        expect(stage.maxWallClockMs).toBe(60_000);
        expect(stage.maxBudgetUsd).toBe(5);
    });

    it('rejects a maxInputTokens below the 1000 floor', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxInputTokens: 500 })).toThrow();
    });

    it('rejects a maxWallClockMs below the 1000 floor', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: 500 })).toThrow();
    });

    /**
     * Card 0030. A stage that can outlive the job carrying it gets that job expired and redelivered
     * while the first attempt is still running — two agents, one worktree, one branch. Config load is
     * the only place that can be caught before it happens, so the ceiling is a schema rule rather
     * than a convention.
     */
    it('rejects a maxWallClockMs that could outlive the job carrying the stage', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: MAX_STAGE_WALL_CLOCK_MS + 1 })).toThrow();
    });

    it('accepts a maxWallClockMs sitting exactly on the ceiling', () => {
        expect(StageConfigSchema.parse({ ...minimalStage, maxWallClockMs: MAX_STAGE_WALL_CLOCK_MS }).maxWallClockMs).toBe(MAX_STAGE_WALL_CLOCK_MS);
    });

    it('leaves the queue expiry with headroom over the longest stage a config can ask for', () => {
        // The job covers more than the run: the worktree, the install, verification and the
        // transition all happen inside it. Equal values would leave none of that room.
        expect(CARD_STAGE_EXPIRES_IN.toMillis()).toBeGreaterThan(MAX_STAGE_WALL_CLOCK_MS);
    });

    it('rejects a maxBudgetUsd of zero, since it must be strictly positive', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxBudgetUsd: 0 })).toThrow();
    });

    it('rejects a negative maxBudgetUsd', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxBudgetUsd: -5 })).toThrow();
    });
});

/**
 * Card 0093 added `maxContextWindowFraction`: a stage stops itself once `Query.getContextUsage()`'s
 * `percentage` crosses this fraction of the model's context window, distinct from `maxInputTokens`
 * because a run can be well under its cumulative token budget and still overflow on a single turn.
 */
describe('StageConfigSchema maxContextWindowFraction', () => {
    it('defaults to 0.9 when omitted', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.maxContextWindowFraction).toBe(0.9);
    });

    it('accepts an explicit fraction', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, maxContextWindowFraction: 0.5 });
        expect(stage.maxContextWindowFraction).toBe(0.5);
    });

    it('accepts a fraction of exactly 1, the top of the window', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, maxContextWindowFraction: 1 });
        expect(stage.maxContextWindowFraction).toBe(1);
    });

    it('rejects a fraction of zero, since it must be strictly positive', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxContextWindowFraction: 0 })).toThrow();
    });

    it('rejects a negative fraction', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxContextWindowFraction: -0.1 })).toThrow();
    });

    it('rejects a fraction above 1, since it names a fraction of the window, not a percentage', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxContextWindowFraction: 1.1 })).toThrow();
    });
});

/**
 * The engine compacts 33k below its window and `getContextUsage` rounds its percentage, so at the
 * default 0.9 the guard fires first from a window of about 314k: a window there could only fail runs.
 */
describe('StageConfigSchema autoCompactWindow', () => {
    it('has no default, leaving the window to the engine', () => {
        expect(StageConfigSchema.parse(minimalStage).autoCompactWindow).toBeUndefined();
    });

    it('accepts a window that compacts before the context guard', () => {
        expect(StageConfigSchema.parse({ ...minimalStage, autoCompactWindow: 140_000 }).autoCompactWindow).toBe(140_000);
    });

    it('draws the line at the default fraction’s crossover', () => {
        expect(StageConfigSchema.safeParse({ ...minimalStage, autoCompactWindow: 314_000 }).success).toBe(true);
        expect(() => StageConfigSchema.parse({ ...minimalStage, autoCompactWindow: 315_000 })).toThrow(/stops the run first/);
    });

    it('accepts a large window once the fraction leaves it room', () => {
        expect(StageConfigSchema.safeParse({ ...minimalStage, autoCompactWindow: 500_000, maxContextWindowFraction: 0.99 }).success).toBe(true);
    });

    it('rejects a fraction that a small window’s compaction can never get ahead of', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, autoCompactWindow: 140_000, maxContextWindowFraction: 0.7 })).toThrow(
            /stops the run first/,
        );
    });

    it('rejects a window outside what the engine honours', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, autoCompactWindow: 99_999 })).toThrow();
        expect(() => StageConfigSchema.parse({ ...minimalStage, autoCompactWindow: 1_000_001 })).toThrow();
    });

    it('checks a step’s own window against the lane’s fraction', () => {
        const step = { name: 'fix', on: 'revise', instructions: 'fix it', autoCompactWindow: 500_000 };
        const parsed = StageConfigSchema.safeParse({ ...minimalStage, steps: [step] });

        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.path).toEqual(['steps', 0, 'autoCompactWindow']);
    });

    it('hands a step the lane’s window unless it names its own', () => {
        const lane = { ...minimalStage, name: 'lane', autoCompactWindow: 140_000 };
        const steps = [
            { name: 'inherits', on: 'revise', instructions: 'a' },
            { name: 'overrides', on: 'approve', instructions: 'b', autoCompactWindow: 200_000 },
        ];
        const stages = ProjectStagesSchema.parse({ stages: [{ ...lane, steps }] });

        expect(findStage(stages, 'lane', 'inherits').autoCompactWindow).toBe(140_000);
        expect(findStage(stages, 'lane', 'overrides').autoCompactWindow).toBe(200_000);
    });
});

/**
 * Card 0018 added `maxCardInputTokens`: a ceiling on everything a card has ever spent, across every
 * stage and every attempt — distinct from `maxInputTokens`, which bounds one run. Absent config must
 * mean unbounded, exactly as every other budget field here already behaves.
 */
describe('StageConfigSchema maxCardInputTokens', () => {
    it('leaves maxCardInputTokens unset when omitted, rather than defaulting it', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.maxCardInputTokens).toBeUndefined();
    });

    it('accepts an explicit maxCardInputTokens', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, maxCardInputTokens: 5_000_000 });
        expect(stage.maxCardInputTokens).toBe(5_000_000);
    });

    it('rejects a maxCardInputTokens below the 1000 floor', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxCardInputTokens: 500 })).toThrow();
    });

    it('rejects a non-integer maxCardInputTokens', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, maxCardInputTokens: 1000.5 })).toThrow();
    });
});

/**
 * Card 0164: a stage may override the project-wide `scopeViolation` for itself alone. Absent means
 * "defer to the project" — resolution happens at `stage.dispatcher.ts`, not here, so the schema's job
 * is only to leave the field unset by default and to accept the same two values the project-wide
 * field already does.
 */
describe('StageConfigSchema scopeViolation override', () => {
    it('leaves scopeViolation unset when omitted, rather than defaulting it — resolution to the project value happens at the dispatcher, not here', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.scopeViolation).toBeUndefined();
    });

    it('accepts an explicit "kickback" override', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, scopeViolation: 'kickback' });
        expect(stage.scopeViolation).toBe('kickback');
    });

    it('accepts an explicit "widen" override', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, scopeViolation: 'widen' });
        expect(stage.scopeViolation).toBe('widen');
    });

    it('rejects an unknown scopeViolation value with the same clarity the project-wide field already gives', () => {
        expect(() => StageConfigSchema.parse({ ...minimalStage, scopeViolation: 'bogus' })).toThrow();
        expect(() => ProjectStagesSchema.shape.scopeViolation.parse('bogus')).toThrow();
    });
});

/**
 * Card 0260: a cli stage can run inside the engine's own OS-level sandbox, off by default. The
 * project-wide `sandbox` block (`ProjectStagesSchema`) carries `enabled` and `allowedDomains`; a
 * stage's own `sandbox` (`StageConfigSchema`) overrides `enabled` alone, resolved by `findStage`
 * exactly the way a stage's own `scopeViolation` already overrides the project-wide value above.
 */
describe('ProjectStagesSchema sandbox block', () => {
    it('defaults to disabled with no allowed domains when omitted entirely', () => {
        const parsed = ProjectStagesSchema.parse({ stages: [] });
        expect(parsed.sandbox).toEqual({ enabled: false, allowedDomains: [] });
    });

    it('accepts an explicit enabled: true with a configured domain list', () => {
        const parsed = ProjectStagesSchema.parse({ stages: [], sandbox: { enabled: true, allowedDomains: ['example.com'] } });
        expect(parsed.sandbox).toEqual({ enabled: true, allowedDomains: ['example.com'] });
    });

    it('rejects an unknown key inside the sandbox block, like every other unknown key (AC6)', () => {
        // Strict, unlike the rest of ProjectStagesSchema's own blocks: a typo here is almost
        // certainly meant to be `enabled` or `allowedDomains`, and silently dropping it would leave
        // an operator believing they had turned sandboxing on.
        const result = ProjectStagesSchema.safeParse({ stages: [], sandbox: { enabled: true, allowdDomains: ['typo.example.com'] } });
        expect(result.success).toBe(false);
    });
});

describe('StageConfigSchema sandbox override', () => {
    it('leaves the stage-level sandbox override unset when omitted, matching scopeViolation’s "defer to project" pattern', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.sandbox).toBeUndefined();
    });

    it('defaults sandboxAllowedDomains to an empty array on the stage schema itself', () => {
        const stage = StageConfigSchema.parse(minimalStage);
        expect(stage.sandboxAllowedDomains).toEqual([]);
    });

    it('accepts an explicit sandbox: true override', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, sandbox: true });
        expect(stage.sandbox).toBe(true);
    });

    it('accepts an explicit sandbox: false override', () => {
        const stage = StageConfigSchema.parse({ ...minimalStage, sandbox: false });
        expect(stage.sandbox).toBe(false);
    });
});

describe('findStage sandbox resolution (AC5)', () => {
    const projectStages = (overrides: Partial<z.input<typeof ProjectStagesSchema>> = {}) =>
        ProjectStagesSchema.parse({ stages: [minimalStage], ...overrides });

    it('resolves sandbox to false with neither the stage nor the project configuring it', () => {
        const stage = findStage(projectStages(), 'implementing');
        expect(stage.sandbox).toBe(false);
        expect(stage.sandboxAllowedDomains).toEqual([]);
    });

    it('falls back to the project-wide default, domains included, when the stage sets nothing', () => {
        const stage = findStage(projectStages({ sandbox: { enabled: true, allowedDomains: ['example.com'] } }), 'implementing');
        expect(stage.sandbox).toBe(true);
        expect(stage.sandboxAllowedDomains).toEqual(['example.com']);
    });

    it('a stage’s own sandbox: true wins even when the project default is off', () => {
        const stage = findStage(projectStages({ stages: [{ ...minimalStage, sandbox: true }] }), 'implementing');
        expect(stage.sandbox).toBe(true);
    });

    it('a stage’s own sandbox: false wins even when the project default is on', () => {
        const stage = findStage(
            projectStages({ stages: [{ ...minimalStage, sandbox: false }], sandbox: { enabled: true, allowedDomains: [] } }),
            'implementing',
        );
        expect(stage.sandbox).toBe(false);
    });
});

describe('assertRoutable codex', () => {
    const codex = { adapter: 'codex', provider: 'openai', model: 'gpt-test' } as const;

    it('accepts an isolated stage on OpenAI', () => {
        expect(() => assertRoutable('implementing', codex, true)).not.toThrow();
    });

    it('refuses a stage not marked isolated', () => {
        expect(() => assertRoutable('implementing', codex)).toThrow(/must be marked isolated/);
    });

    it('refuses any provider but OpenAI', () => {
        expect(() => assertRoutable('implementing', { ...codex, provider: 'anthropic' }, true)).toThrow(/always runs OpenAI/);
    });

    it('refuses the planning session', () => {
        expect(() => assertRoutable('planning', codex, true)).toThrow(/planning session always runs Claude/);
    });
});

describe('findStage with a step', () => {
    const stages = parseStages(`
stages:
  - name: review
    mode: agent
    model: claude-opus
    worktree: readonly
    maxSteps: 150
    maxIdleMs: 200000
    allowedCommands: [git diff]
    instructions: find what is wrong
    onPass: ready
    onFail: implementing
    steps:
      - name: challenge
        on: revise
        maxSteps: 100
        instructions: try to refute it
  - name: ready
    mode: manual
    instructions: wait
    onPass: merged
    onFail: review
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: build it
    onPass: review
    onFail: implementing
`);

    it("overlays the step, keeping the lane's routes, model and anything it does not name", () => {
        expect(findStage(stages, 'review', 'challenge')).toMatchObject({
            name: 'review',
            step: 'challenge',
            verifier: 'challenge',
            instructions: 'try to refute it',
            maxSteps: 100,
            model: 'claude-opus',
            onPass: 'ready',
            onFail: 'implementing',
            worktree: 'readonly',
            allowedCommands: ['git diff'],
        });
    });

    it('runs as an agent on a manual lane unless it says otherwise', () => {
        const manual = parseStages(`
stages:
  - name: planning
    mode: manual
    model: claude-opus
    worktree: none
    instructions: talk it through
    onPass: merged
    onFail: planning
    steps:
      - name: scope-check
        on: approve
        worktree: readonly
        instructions: judge it
`);
        expect(findStage(manual, 'planning', 'scope-check')).toMatchObject({ mode: 'agent', worktree: 'readonly' });
    });

    it('leaves the lane itself untouched, and says stage-not-found for no such step', () => {
        expect(findStage(stages, 'review')).toMatchObject({ instructions: 'find what is wrong', maxSteps: 150, verifier: 'review' });
        expect(findStage(stages, 'review').step).toBeUndefined();
        expect(() => findStage(stages, 'review', 'nope')).toThrow(/no step named "nope"/);
    });
});

describe('routing the ready lane', () => {
    it('takes a Claude model and nothing else', () => {
        expect(() => assertRoutable('ready', { adapter: 'cli', provider: 'anthropic', model: 'claude-opus-5-5' })).not.toThrow();
        expect(() => assertRoutable('ready', { adapter: 'api', provider: 'openai', model: 'gpt-5' })).toThrow(/review workspace always runs Claude/);
        expect(() => assertRoutable('ready', { adapter: 'codex', provider: 'openai', model: 'gpt-5' })).toThrow(
            /review workspace always runs Claude/,
        );
    });
});
