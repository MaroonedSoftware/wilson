import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { StageAgentMap, type AgentRunInput, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { ImplementingResultSchema, StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { StageVerifierMap, type StageVerifier } from '#modules/stages/stage.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };

const STAGES = `
stages:
  - name: implementing
    mode: agent
    adapter: cli
    model: claude-opus-5
    instructions: build it
    onPass: testing
    onFail: testing
    maxKickbacks: 3
  - name: testing
    mode: agent
    adapter: cli
    model: claude-opus-5
    instructions: test it
    onPass: merged
    onFail: testing
`;

const LOOP = 'stopped in a loop: made the same Bash call 8 times with nothing written between them, {"command":"pnpm test"}';
const loops: AgentRunOutput = { loopFailure: LOOP, truncated: true, usage: { inputTokens: 100, outputTokens: 7 } };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/** Real board, real git and real event log; a stub agent, since what matters is what becomes of the card. */
describe('StageDispatcher after a run stopped in a loop', () => {
    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-loop-'));
        const codeRoot = join(base, 'code');
        await mkdir(join(codeRoot, 'src'), { recursive: true });
        await writeFile(join(codeRoot, 'src', 'kept.ts'), 'export const kept = 1;\n', 'utf8');
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig(uniqueProject(), codeRoot, join(base, 'worktrees'), join(base, 'run'));
        const events = new EventLog(db, silentLogger as never);
        const board = new PostgresBoardRepository(config, db, events);
        const worktrees = new WorktreeManager(config, silentLogger as never);

        await board.create(
            {
                frontmatter: { id: '0001', title: 'a card', stage: 'implementing', dependsOn: [], retries: {} },
                sections: { 'Files in scope': '- src/kept.ts' },
                body: '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/kept.ts\n',
            },
            'seed',
        );
        const pin = await board.currentVersion('0001');
        await board.write('0001', 'pin', card => ({ ...card, frontmatter: { ...card.frontmatter, planVersionId: pin } }));

        const verified: string[] = [];
        const verifier: StageVerifier = {
            verify: async ({ stage }) => {
                verified.push(stage.name);
                return { passed: true, failures: [], changedPaths: [] };
            },
        };
        const verifiers = new StageVerifierMap();
        verifiers.set('implementing', verifier);
        const schemas = new StageResultSchemaMap();
        schemas.set('implementing', ImplementingResultSchema);

        const inputs: AgentRunInput[] = [];
        const plans: string[] = [];
        const outputs: AgentRunOutput[] = [];
        const agents = new StageAgentMap();
        agents.set('cli', {
            run: async (input: AgentRunInput) => {
                inputs.push(input);
                plans.push(await readFile(input.planPath, 'utf8'));
                return outputs.shift() ?? loops;
            },
        } as never);

        const dispatcher = new StageDispatcher(
            config,
            new StaticStageConfigStore(STAGES),
            board,
            worktrees,
            agents,
            verifiers,
            schemas,
            events,
            silentLogger as never,
        );
        return {
            board,
            verified,
            inputs,
            plans,
            outputs,
            run: () => dispatcher.run('0001', 'implementing'),
            failedEvents: async () => (await events.tail(config.project, '0001', 100)).filter(event => event.type === 'stage.failed'),
        };
    };

    it('fails on the loop alone, retrying in its own stage, without running the verifier', async () => {
        const { board, verified, failedEvents, run } = await setUp();

        const outcome = await run();

        expect(outcome).toMatchObject({ passed: false, needsHuman: false, transitionedTo: 'implementing' });
        expect(verified).toEqual([]);
        const { frontmatter } = await board.read('0001');
        expect(frontmatter.stage).toBe('implementing');
        expect(frontmatter.retries).toEqual({ implementing: 1 });

        const [failed] = await failedEvents();
        expect(failed?.payload).toMatchObject({
            failures: [LOOP],
            loopStopped: true,
            failureClass: 'loop',
            reason: LOOP,
            usage: { inputTokens: 100, outputTokens: 7 },
        });
    });

    it('tells the retry why the last run stopped, and starts it in a fresh session', async () => {
        const { inputs, plans, run } = await setUp();

        await run();
        expect(plans[0]).not.toContain('Previous attempts');

        await run();
        expect(plans[1]).toContain('Previous attempts');
        expect(plans[1]).toContain('stopped in a loop: made the same Bash call 8 times');
        expect(inputs[1]?.resume).toBeUndefined();
    });

    it('flags the card for a person once the retries are spent, rather than looping for ever', async () => {
        const { board, inputs, run } = await setUp();

        await run();
        await run();
        const outcome = await run();

        expect(outcome).toMatchObject({ passed: false, needsHuman: true, transitionedTo: 'implementing' });
        expect(inputs).toHaveLength(3);
        const { frontmatter, body } = await board.read('0001');
        expect(frontmatter.retries).toEqual({ implementing: 3 });
        expect(frontmatter.needsHuman).toBe(true);
        expect(body.match(/stopped in a loop/g)).toHaveLength(3);
    });

    it('still writes no bullet for any other unjudged failure, so the exception stays narrow', async () => {
        const { board, outputs, run } = await setUp();
        outputs.push({ truncated: true, budgetFailure: 'wall-clock budget exceeded: cap 1000ms' });

        await run();

        expect((await board.read('0001')).body).not.toContain('Previous attempts');
    });
});
