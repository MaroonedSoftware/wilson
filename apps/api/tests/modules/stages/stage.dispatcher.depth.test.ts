import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { StageAgentMap, type AgentRunInput, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageInterruptedError, type InterruptedAttempt } from '#modules/agent/stage.interrupt.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { HostPlacer } from '#modules/host/host.placer.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const exec = promisify(execFile);

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const LADDER = `
    depths:
      - { minChangedLines: 0, model: small-model, maxSteps: 40, maxInputTokens: 2000000 }
      - { minChangedLines: 100, model: large-model, maxSteps: 300 }`;

const lanes = (depths = LADDER, extra = '') => `
stages:
  - name: review
    mode: agent
    worktree: readonly
    model: lane-model
    maxSteps: 150
    maxInputTokens: 20000000${extra}
    instructions: review it
    onPass: merged
    onFail: review${depths}
    steps:
      - name: challenge
        on: revise
        mode: agent
        instructions: challenge it
`;

const manyLines = (count: number): string => Array.from({ length: count }, (_, index) => `line ${index}`).join('\n') + '\n';

/** A real repo and board, with the card's branch `changedLines` lines ahead of main, or not cut at all at 0. */
const build = async (changedLines: number, stageConfig: string, options: { interruptOnce?: boolean } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'dispatcher-depth-'));
    const codeRoot = join(root, 'code');
    await mkdir(join(codeRoot, 'src'), { recursive: true });
    const git = (...args: string[]) => exec('git', args, { cwd: codeRoot });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 't@example.com');
    await git('config', 'user.name', 't');
    await writeFile(join(codeRoot, 'src', 'x.ts'), 'export const x = 1;\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'base');
    if (changedLines > 0) {
        await git('checkout', '-q', '-b', 'card/0001');
        await writeFile(join(codeRoot, 'src', 'work.ts'), manyLines(changedLines));
        await git('add', '-A');
        await git('commit', '-q', '-m', 'work');
        await git('checkout', '-q', 'main');
    }

    const config = new StaticBoardConfig(uniqueProject(), codeRoot, join(root, 'worktrees'), join(root, 'run'));
    const events = { append: vi.fn<EventLog['append']>(async () => {}), budgetedInputTokens: vi.fn(async () => 0), tail: vi.fn(async () => []) };
    const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    const card: Card = {
        frontmatter: { id: '0001', title: 'do the thing', stage: 'review', branch: 'card/0001', dependsOn: [], retries: {} },
        sections: { 'Files in scope': '- src/**' },
        body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/**\n',
    };
    await board.create(card, 'initial');

    const inputs: AgentRunInput[] = [];
    let interrupts = options.interruptOnce ? 1 : 0;
    const agents = new StageAgentMap();
    agents.set('api', {
        run: async (input: AgentRunInput): Promise<AgentRunOutput> => {
            inputs.push(input);
            if (interrupts-- > 0) {
                return { usage: { inputTokens: 100 }, truncated: true, interrupted: { sessionId: 'session-1', wallClockMs: 1000, steps: 5 } };
            }
            return { result: { summary: 'looked' }, usage: { inputTokens: 10 }, truncated: false };
        },
    });
    const verifiers = new StageVerifierMap();
    const resultSchemas = new StageResultSchemaMap();
    for (const name of ['review', 'challenge']) {
        verifiers.set(name, { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) });
        resultSchemas.set(name, {} as never);
    }

    const worktrees = new WorktreeManager(config, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never);
    const measure = vi.spyOn(worktrees, 'diffstatSinceFork');
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const place = vi.fn<HostPlacer['place']>(async () => undefined);
    const placer = { place, takeLocalSlot: vi.fn(async () => ({ key: 'local:slot:1' })), releaseSlot: vi.fn(async () => {}) };
    const stages = new StaticStageConfigStore(stageConfig);
    /** Grow the branch from inside the worktree an interrupted stage left. */
    const growBranch = async (lines: number) => {
        const tree = join(config.worktreeRoot, '0001');
        await writeFile(join(tree, 'src', 'more.ts'), manyLines(lines));
        await exec('git', ['add', '-A'], { cwd: tree });
        await exec('git', ['commit', '-q', '-m', 'more work'], { cwd: tree });
    };
    const dispatcher = new StageDispatcher(
        config,
        stages,
        board,
        worktrees,
        agents,
        verifiers,
        resultSchemas,
        events as unknown as EventLog,
        logger as never,
        undefined,
        undefined,
        undefined,
        placer as unknown as HostPlacer,
    );
    const dispatched = () => events.append.mock.calls.map(([event]) => event).filter(event => event.type === 'stage.dispatched');
    return { dispatcher, inputs, measure, logger, place, dispatched, growBranch, stages };
};

describe('StageDispatcher depth', () => {
    it('runs a small diff on the low tier, and records it on stage.dispatched', async () => {
        const { dispatcher, inputs, dispatched } = await build(5, lanes());

        await dispatcher.run('0001', 'review');

        expect(inputs[0]?.stage).toMatchObject({ model: 'small-model', maxSteps: 40, maxInputTokens: 2_000_000 });
        const payload = dispatched()[0]?.payload;
        expect(payload).toMatchObject({ model: 'small-model', depth: { minChangedLines: 0, model: 'small-model' } });
    });

    it('runs a large diff on the high tier, keeping the lane’s budget where the tier names none', async () => {
        const { dispatcher, inputs } = await build(150, lanes());

        await dispatcher.run('0001', 'review');

        expect(inputs[0]?.stage).toMatchObject({ model: 'large-model', maxSteps: 300, maxInputTokens: 20_000_000 });
    });

    it('shows placement the stage that will run', async () => {
        const { dispatcher, place } = await build(150, lanes());

        await dispatcher.run('0001', 'review');

        expect(place.mock.calls[0]?.[2]).toMatchObject({ model: 'large-model' });
    });

    it('still lets the card’s ceiling cut a tier’s budget down', async () => {
        const { dispatcher, inputs } = await build(5, lanes(LADDER, '\n    maxCardInputTokens: 1000000'));

        await dispatcher.run('0001', 'review');

        expect(inputs[0]?.stage.maxInputTokens).toBe(1_000_000);
    });

    it('measures nothing and records no tier on a lane that configures none', async () => {
        const { dispatcher, inputs, measure, dispatched } = await build(150, lanes(''));

        await dispatcher.run('0001', 'review');

        expect(measure).not.toHaveBeenCalled();
        expect(inputs[0]?.stage).toMatchObject({ model: 'lane-model', maxSteps: 150 });
        expect(dispatched()[0]?.payload).not.toHaveProperty('depth');
    });

    it('runs a step on the lane’s own model, whatever the diff', async () => {
        const { dispatcher, inputs, measure, dispatched } = await build(150, lanes());

        await dispatcher.run('0001', 'review', undefined, 'challenge');

        expect(measure).not.toHaveBeenCalled();
        expect(inputs[0]?.stage).toMatchObject({ step: 'challenge', model: 'lane-model', maxSteps: 150 });
        expect(dispatched()[0]?.payload).not.toHaveProperty('depth');
    });

    it('runs the lane as written for a branch not cut yet', async () => {
        const { dispatcher, inputs, logger } = await build(0, lanes());

        await dispatcher.run('0001', 'review');

        expect(inputs[0]?.stage).toMatchObject({ model: 'lane-model', maxSteps: 150 });
        expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('measure'));
    });

    it('runs the lane as written, and says so, when git cannot measure the diff', async () => {
        const { dispatcher, inputs, measure, logger, dispatched } = await build(5, lanes());
        measure.mockRejectedValue(new Error('git fell over'));

        await dispatcher.run('0001', 'review');

        expect(inputs[0]?.stage).toMatchObject({ model: 'lane-model', maxSteps: 150 });
        expect(dispatched()[0]?.payload).not.toHaveProperty('depth');
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('git fell over'));
    });

    describe('after an interruption', () => {
        const interruptedRun = async () => {
            const built = await build(5, lanes(), { interruptOnce: true });
            const error = await built.dispatcher.run('0001', 'review').catch((err: unknown) => err);
            expect(error).toBeInstanceOf(StageInterruptedError);
            return { ...built, attempt: (error as StageInterruptedError).attempt };
        };

        it('carries the tier on the attempt', async () => {
            const { attempt } = await interruptedRun();

            expect(attempt.depth).toMatchObject({ minChangedLines: 0, model: 'small-model' });
        });

        it('resumes the session on the tier it started on, though the diff has since grown past it', async () => {
            const { dispatcher, inputs, attempt, measure, growBranch } = await interruptedRun();
            measure.mockClear();
            await growBranch(150);

            await dispatcher.run('0001', 'review', attempt);

            expect(measure).not.toHaveBeenCalled();
            expect(inputs[1]?.resume).toEqual({ sessionId: 'session-1' });
            expect(inputs[1]?.stage).toMatchObject({ model: 'small-model', maxSteps: 40 - 5, maxInputTokens: 2_000_000 - 100 });
        });

        it('keeps the tier when the lane has dropped its depths meanwhile', async () => {
            const { dispatcher, inputs, attempt, stages } = await interruptedRun();
            await stages.save(lanes(''));

            await dispatcher.run('0001', 'review', attempt);

            expect(inputs[1]?.stage).toMatchObject({ model: 'small-model' });
        });

        it('keeps a session that started on no tier on none', async () => {
            const { dispatcher, inputs, measure } = await build(150, lanes());
            const attempt: InterruptedAttempt = { baseSha: 'gone', sessionId: 'session-1' };

            await dispatcher.run('0001', 'review', attempt);

            expect(measure).not.toHaveBeenCalled();
            expect(inputs[0]?.stage).toMatchObject({ model: 'lane-model' });
        });
    });
});
