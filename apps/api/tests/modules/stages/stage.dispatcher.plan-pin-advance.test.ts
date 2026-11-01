import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore, type StageConfigStore } from '#modules/stages/stage.config.store.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap, type StageVerifier } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/**
 * Card 0129. Before this change, `StageDispatcher.writeTransition` never touched
 * `frontmatter.planVersionId` — the pin a pinned card carries stayed exactly where `approve` set it,
 * no matter how many times the runner itself folded a `## Review findings` section into the body
 * afterward. That is card 0091's bug: three implementing passes each read the plan at the same stale
 * pinned version, which had no findings section at all, so each one correctly found the (nonexistent)
 * work already done and produced an empty diff.
 *
 * These tests exercise `writeTransition` directly (private access, the same pattern
 * `stage.dispatcher.test.ts` already uses for this method) against a real `PostgresBoardRepository` —
 * assembling the whole agent loop through `run()` is not needed to observe whether the pin moves,
 * since the write happens in `writeTransition` and nowhere else.
 */
describe("StageDispatcher advances a pinned card's planVersionId past the findings its own kickback just wrote (card 0129)", () => {
    const baseCard: Card = {
        frontmatter: {
            id: '0001',
            title: 'do the thing',
            stage: 'review',
            dependsOn: [],
            retries: {},
        },
        sections: {},
        body: '## Goal\n\nDo the thing.',
    };

    const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
        name: 'review',
        mode: 'agent',
        worktree: 'rw',
        provider: 'anthropic',
        model: 'claude-opus',
        instructions: 'review it',
        allowedCommands: [],
        worktreeFrom: 'branch',
        extraScope: [],
        baselineCheck: true,
        maxSteps: 60,
        maxOutputTokens: 16000,
        onPass: 'merged',
        onFail: 'implementing',
        maxKickbacks: 3,
        ...overrides,
    });

    const outcome = (overrides: Partial<StageOutcome> = {}): StageOutcome => ({
        passed: true,
        failures: [],
        changedPaths: [],
        scopeGrants: [],
        usage: {},
        ...overrides,
    });

    const revisionOutcome = (): StageOutcome =>
        outcome({
            passed: true,
            result: {
                verdict: 'revise',
                findings: [{ severity: 'blocker', file: 'src/x.ts', line: 3, problem: 'off by one', suggestion: 'fix the index' }],
            },
        });

    let board: BoardRepository;
    let dispatcher: StageDispatcher;

    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-plan-pin-'));
        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        // Card 0234: a judged failure now calls `failedAttemptPatchPath` unconditionally while
        // building its attempts bullet, so the worktrees stub needs a real function here — the
        // "no findings" test below hits exactly that branch (`passed: false`, judged).
        const worktrees = { failedAttemptPatchPath: (cardId: string) => join(config.runRoot, 'cards', cardId, 'last-failed-attempt.patch') };
        dispatcher = new StageDispatcher(
            config as BoardConfig,
            {} as StageConfigStore,
            board,
            worktrees as unknown as WorktreeManager,
            {} as StageAgentMap,
            {} as StageVerifierMap,
            {} as StageResultSchemaMap,
            events as unknown as EventLog,
            silentLogger as never,
        );
        return { board, events };
    };

    const writeTransition = (stage: StageConfig, head: Card, result: StageOutcome, card: Card = head) =>
        (
            dispatcher as unknown as {
                writeTransition(
                    cardId: string,
                    stageName: string,
                    stage: StageConfig,
                    head: Card,
                    card: Card,
                    outcome: StageOutcome,
                ): Promise<{ target: string; needsHuman: boolean }>;
            }
        ).writeTransition('0001', 'review', stage, head, card, result);

    it('advances a pinned card’s planVersionId to the version that just folded the findings in', async () => {
        await setUp();
        const created = await board.create(baseCard, 'initial');
        // Mimics `approve`: the pin names a real, existing version — here, the pre-kickback one,
        // which carries no findings section.
        await board.write('0001', 'approve', c => ({ ...c, frontmatter: { ...c.frontmatter, planVersionId: created } }));
        const head = await board.read('0001');
        expect(head.frontmatter.planVersionId).toBe(created);

        const { target } = await writeTransition(makeStage(), head, revisionOutcome());
        expect(target).toBe('implementing');

        const stored = await board.read('0001');
        // The pin moved off the pre-kickback version entirely...
        expect(stored.frontmatter.planVersionId).toBeDefined();
        expect(stored.frontmatter.planVersionId).not.toBe(created);

        // ...to a version whose body actually carries the findings a re-dispatched implementing pass
        // needs to read — the version `writeTransition`'s own `writeWithEvent` just created.
        const pinned = await board.readAt('0001', stored.frontmatter.planVersionId!);
        expect(pinned.body).toContain('## Review findings');
        expect(pinned.body).toContain('src/x.ts:3');
        expect(pinned.frontmatter.stage).toBe('implementing');
    });

    it('leaves an unpinned card with no planVersionId after a kickback with findings', async () => {
        await setUp();
        await board.create(baseCard, 'initial');
        const head = await board.read('0001');
        expect(head.frontmatter.planVersionId).toBeUndefined();

        await writeTransition(makeStage(), head, revisionOutcome());

        const stored = await board.read('0001');
        expect(stored.frontmatter.planVersionId).toBeUndefined();
        // The findings still land in the body — only the pin behaviour is untouched for a card that
        // never had one.
        expect(stored.body).toContain('## Review findings');
    });

    // Card 0234 widened this from "no findings" to "no bullet either": a judged failure with no
    // findings still writes a `## Previous attempts` bullet and legitimately advances the pin now
    // (see `stage.dispatcher.attempts.test.ts`) — the one outcome that still changes nothing in the
    // body is an unjudged failure, which `writeTransition` deliberately records no bullet for.
    it('leaves planVersionId untouched when the kickback is unjudged and the body does not change', async () => {
        await setUp();
        const created = await board.create(baseCard, 'initial');
        await board.write('0001', 'approve', c => ({ ...c, frontmatter: { ...c.frontmatter, planVersionId: created } }));
        const head = await board.read('0001');

        await writeTransition(makeStage(), head, outcome({ passed: false, unjudged: true }));

        const stored = await board.read('0001');
        expect(stored.frontmatter.planVersionId).toBe(created);
        expect(stored.body).toBe(baseCard.body);
    });

    it('leaves a pinned card’s planVersionId untouched when review passes cleanly (no findings section at all)', async () => {
        await setUp();
        const created = await board.create(baseCard, 'initial');
        await board.write('0001', 'approve', c => ({ ...c, frontmatter: { ...c.frontmatter, planVersionId: created } }));
        const head = await board.read('0001');

        const { target } = await writeTransition(makeStage(), head, outcome({ passed: true, result: { verdict: 'pass', findings: [] } }));

        expect(target).toBe('merged');
        const stored = await board.read('0001');
        expect(stored.frontmatter.planVersionId).toBe(created);
    });

    /**
     * `BoardWriteService.approve` pins the version *before* its own write lands (the deliberate
     * off-by-one at `board.write.service.ts:136`). That call site is untouched by this card, but the
     * behaviour it depends on — `write`/`writeWithEvent` still committing the mutate exactly once
     * and returning the id of what that call itself created, not some other write — is exactly what
     * every assertion above already leans on. Nothing about advancing the pin for findings can be
     * allowed to make one write ever describe more than the version it produced.
     */
    it('advances the pin in the transition write itself, adding no version of its own', async () => {
        await setUp();
        const created = await board.create(baseCard, 'initial');
        await board.write('0001', 'approve', c => ({ ...c, frontmatter: { ...c.frontmatter, planVersionId: created } }));
        const head = await board.read('0001');

        const before = await board.versions('0001', 50);
        expect(before).toHaveLength(2); // create, approve

        await writeTransition(makeStage(), head, revisionOutcome());

        const after = await board.versions('0001', 50);
        expect(after).toHaveLength(3);
    });

    it('leaves neither the move nor the pin behind when the transition cannot commit', async () => {
        const { events } = await setUp();
        const created = await board.create(baseCard, 'initial');
        await board.write('0001', 'approve', c => ({ ...c, frontmatter: { ...c.frontmatter, planVersionId: created } }));
        const head = await board.read('0001');
        events.append.mockRejectedValueOnce(new Error('connection lost'));

        await expect(writeTransition(makeStage(), head, revisionOutcome())).rejects.toThrow('connection lost');

        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('review');
        expect(stored.frontmatter.planVersionId).toBe(created);
    });
});

/**
 * Card 0129's actual payoff, end to end through `run()`: a pinned card kicked back from review with
 * findings must hand the *next* dispatched pass a materialized `plan.md` that contains those
 * findings, not the stale pre-kickback plan (card 0091's bug — three implementing passes reading a
 * plan whose findings section did not exist yet).
 *
 * Structured after `stage.dispatcher.branch-recording.test.ts`: two agent stages sharing one resumed
 * branch, `worktrees` fully mocked, real `PostgresBoardRepository` and `run()`.
 */
describe("StageDispatcher's next dispatch reads the findings a prior kickback just wrote (card 0129, end to end)", () => {
    const stagesYaml = `
stages:
  - name: review
    mode: agent
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: implementing
    worktreeFrom: branch
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: review
    onFail: implementing
    worktreeFrom: branch
`;

    const seedCard: Card = {
        frontmatter: {
            id: '0001',
            title: 'do the thing',
            stage: 'review',
            dependsOn: [],
            retries: {},
        },
        sections: { 'Files in scope': '- src/x.ts' },
        body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
    };

    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-plan-pin-e2e-'));

        const worktreeDir = join(base, 'worktree');
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await writeFile(join(worktreeDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);

        const created = await board.create(seedCard, 'seed');
        // The pin is set once, at "approval", to the pre-kickback version — exactly the version whose
        // body has no findings section, matching what `approve` does in production.
        await board.write('0001', 'approve', c => ({ ...c, frontmatter: { ...c.frontmatter, planVersionId: created } }));

        const worktrees = {
            resolveBranch: vi.fn(() => 'card/0001-do-the-thing'),
            hasWork: vi.fn(async () => true),
            create: vi.fn(async () => {
                throw new Error('MARKER: should not create — both stages here resume (worktreeFrom: branch)');
            }),
            resume: vi.fn(async () => ({ path: worktreeDir, baseSha: 'deadbeef' })),
            rebaseOntoHead: vi.fn(async () => ({ ok: true, baseSha: 'deadbeef' })),
            commit: vi.fn(async () => 'committedsha'),
            reclaim: vi.fn(async () => {}),
            failedAttemptPatchPath: vi.fn(() => '/tmp/never-used.patch'),
        };

        return { config, board, events, worktrees, created };
    };

    const buildDispatcher = (config: StaticBoardConfig, board: BoardRepository, events: { append: ReturnType<typeof vi.fn> }, worktrees: unknown) => {
        const agents = new StageAgentMap();
        agents.set('api', {
            run: async (input: { stage: StageConfig }): Promise<AgentRunOutput> => {
                if (input.stage.name === 'review') {
                    return {
                        result: {
                            verdict: 'revise',
                            summary: 'found a bug',
                            findings: [{ severity: 'blocker', file: 'src/x.ts', line: 1, problem: 'off by one', suggestion: 'fix the index' }],
                        },
                        usage: { inputTokens: 10 },
                        truncated: false,
                    };
                }
                return { result: { summary: 'fixed the bug' }, usage: { inputTokens: 10 }, truncated: false };
            },
        });

        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) };
        verifiers.set('review', verifier);
        verifiers.set('implementing', verifier);

        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('review', {} as never);
        resultSchemas.set('implementing', {} as never);

        return new StageDispatcher(
            config,
            new StaticStageConfigStore(stagesYaml),
            board,
            worktrees as unknown as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            events as unknown as EventLog,
            silentLogger as never,
        );
    };

    it('materializes a plan.md carrying the review findings for the pass dispatched right after the kickback', async () => {
        const { config, board, worktrees, events, created } = await setUp();
        const dispatcher = buildDispatcher(config, board, events, worktrees);

        const first = await dispatcher.run('0001', 'review');
        expect(first.passed).toBe(true);
        expect(first.transitionedTo).toBe('implementing');

        const afterFirst = await board.read('0001');
        expect(afterFirst.frontmatter.planVersionId).toBeDefined();
        expect(afterFirst.frontmatter.planVersionId).not.toBe(created);

        // The dispatcher's own pinned read (what `run()` hands to `materializePlan`) now sees the
        // findings — this is the fix, isolated from the second dispatch below.
        const pinnedNow = await board.readAt('0001', afterFirst.frontmatter.planVersionId!);
        expect(pinnedNow.body).toContain('## Review findings');

        // The second dispatch is the actual regression card 0091 hit: before this change, this read
        // the *original* pinned version — no findings section — and correctly, uselessly, found
        // nothing left to do.
        const second = await dispatcher.run('0001', 'implementing');
        expect(second.passed).toBe(true);

        const plan = await readFile(join(config.runRoot, 'cards', '0001', 'plan.md'), 'utf8');
        expect(plan).toContain('## Review findings');
        expect(plan).toContain('off by one');
    });
});
