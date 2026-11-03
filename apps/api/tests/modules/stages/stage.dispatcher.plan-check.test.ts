import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { StageAgentMap, type AgentRunInput } from '#modules/agent/stage.agent.js';
import { NotDispatchableError, StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { ScopeCheckResultSchema, StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { StageVerifierMap, type StageVerifier, type VerificationOutcome } from '#modules/stages/stage.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };

const STAGES = `
stages:
  - name: planning
    mode: manual
    worktree: none
    model: claude-opus-5
    instructions: talk it through
    onPass: backlog
    onFail: parking-lot
    maxKickbacks: 3
    steps:
      - name: scope-check
        on: approve
        worktree: readonly
        instructions: judge the plan
  - name: backlog
    mode: manual
    worktree: none
    instructions: wait
    onPass: implementing
    onFail: planning
  - name: implementing
    mode: agent
    model: claude-opus-5
    instructions: build it
    onPass: merged
    onFail: implementing
`;

const REPORT = {
    summary: 'one thing',
    groups: [{ title: 'the thing', tasks: ['do it'], sites: 1 }],
    verdict: 'pass',
    reason: 'it holds together',
    division: [],
};

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/**
 * A plan check is a step of `planning`, started by approval: the card waits in `planning` while it
 * runs, and only a pass reaches `backlog`. Real board, real git, stub agent and verifier, since what
 * these pin is where the card ends up, not what `ScopeCheckVerifier` makes of a report.
 */
describe('StageDispatcher running a plan check', () => {
    const setUp = async (
        outcome: Partial<VerificationOutcome>,
        seed: Partial<Card['frontmatter']> = { planCheck: 'checking' },
        truncated = false,
    ) => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-plan-check-'));
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
        // A dependency nowhere near finished: a check judges the plan, so it does not wait for this.
        await board.create(
            { frontmatter: { id: '0099', title: 'first', stage: 'implementing', dependsOn: [], retries: {} }, sections: {}, body: '' },
            'seed',
        );
        await board.create(
            {
                frontmatter: { id: '0001', title: 'a plan', stage: 'planning', dependsOn: ['0099'], retries: {}, ...seed },
                sections: { 'Files in scope': '- src/kept.ts' },
                body: '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/kept.ts\n',
            },
            'seed',
        );
        // `create` does not write this column: a card only ever gets it from an approval.
        if (seed.planCheck)
            await board.write('0001', 'approve', card => ({ ...card, frontmatter: { ...card.frontmatter, planCheck: seed.planCheck } }));

        const agents = new StageAgentMap();
        const runs: string[] = [];
        agents.set('cli', {
            run: async (input: AgentRunInput) => {
                runs.push(`${input.stage.name}/${input.stage.step}/${input.stage.adapter}/${input.stage.model}`);
                return { result: truncated ? undefined : REPORT, usage: { inputTokens: 1 }, truncated };
            },
        } as never);
        const verifier: StageVerifier = {
            verify: async () => ({ passed: true, failures: [], changedPaths: [], ...outcome }),
        };
        const verifiers = new StageVerifierMap();
        verifiers.set('scope-check', verifier);
        const schemas = new StageResultSchemaMap();
        schemas.set('scope-check', ScopeCheckResultSchema);

        const dispatcher = new StageDispatcher(
            config,
            new StaticStageConfigStore(STAGES),
            board,
            new WorktreeManager(config, silentLogger as never),
            agents,
            verifiers,
            schemas,
            events,
            silentLogger as never,
        );
        return { dispatcher, board, runs };
    };

    it("moves a passing card to backlog, clearing the check, on planning's model and the cli engine", async () => {
        const { dispatcher, board, runs } = await setUp({});

        const outcome = await dispatcher.run('0001', 'planning', undefined, 'scope-check');

        expect(outcome.transitionedTo).toBe('backlog');
        expect(outcome.nextStep).toBeUndefined();
        expect(runs).toEqual(['planning/scope-check/cli/claude-opus-5']);
        const after = await board.read('0001');
        expect(after.frontmatter.stage).toBe('backlog');
        expect(after.frontmatter.planCheck).toBeUndefined();
    });

    it('leaves a refused card in planning with the reason, wherever the lane sends its own failures', async () => {
        const { dispatcher, board } = await setUp({ passed: false, failures: ['refusing: three unrelated changes'] });

        const outcome = await dispatcher.run('0001', 'planning', undefined, 'scope-check');

        expect(outcome.transitionedTo).toBe('planning');
        expect(outcome.nextStep).toBeUndefined();
        const after = await board.read('0001');
        expect(after.frontmatter.stage).toBe('planning');
        expect(after.frontmatter.planCheck).toBe('refused');
        expect(after.frontmatter.planCheckReason).toContain('three unrelated changes');
    });

    it('does not run for a card whose check was cancelled by a new plan', async () => {
        const { dispatcher, runs } = await setUp({}, {});

        await expect(dispatcher.run('0001', 'planning', undefined, 'scope-check')).rejects.toBeInstanceOf(NotDispatchableError);
        expect(runs).toEqual([]);
    });

    it('does not let a check approve a plan changed while it ran', async () => {
        const { dispatcher, board } = await setUp({});
        const { verifiers } = dispatcher as unknown as { verifiers: StageVerifierMap };
        verifiers.set('scope-check', {
            verify: async () => {
                await board.write('0001', 'a new plan', card => {
                    const { planCheck: _planCheck, ...frontmatter } = card.frontmatter;
                    return { ...card, frontmatter };
                });
                return { passed: true, failures: [], changedPaths: [] };
            },
        });

        const outcome = await dispatcher.run('0001', 'planning', undefined, 'scope-check');

        expect(outcome.transitionedTo).toBeUndefined();
        expect((await board.read('0001')).frontmatter.stage).toBe('planning');
    });

    it('runs the check again, still checking, when it never reached a judgment', async () => {
        const { dispatcher, board } = await setUp({}, { planCheck: 'checking' }, true);

        const outcome = await dispatcher.run('0001', 'planning', undefined, 'scope-check');

        expect(outcome.passed).toBe(false);
        expect(outcome.transitionedTo).toBe('planning');
        expect(outcome.nextStep).toBe('scope-check');
        expect((await board.read('0001')).frontmatter.planCheck).toBe('checking');
    });
});
