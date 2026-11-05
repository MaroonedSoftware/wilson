import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { StageAgentMap } from '#modules/agent/stage.agent.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { ImplementingResultSchema, StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { StageVerifierMap, type VerificationOutcome } from '#modules/stages/stage.verifier.js';
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

const PLAN = '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/kept.ts\n';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/** Real board and real git; a stub verifier, since what matters is what becomes of the card. */
describe('StageDispatcher: a verifier that asks for a person', () => {
    const setUp = async (verdict: VerificationOutcome) => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-secret-flag-'));
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
        await board.create(
            {
                frontmatter: { id: '0001', title: 'a card', stage: 'implementing', dependsOn: [], retries: {} },
                sections: { 'Files in scope': '- src/kept.ts' },
                body: PLAN,
            },
            'seed',
        );
        const pin = await board.currentVersion('0001');
        await board.write('0001', 'pin', card => ({ ...card, frontmatter: { ...card.frontmatter, planVersionId: pin } }));

        const verifiers = new StageVerifierMap();
        verifiers.set('implementing', { verify: async () => verdict });
        const schemas = new StageResultSchemaMap();
        schemas.set('implementing', ImplementingResultSchema);
        const agents = new StageAgentMap();
        agents.set('cli', {
            run: async () => ({
                truncated: false,
                result: { summary: 'did it', filesTouched: [], caveats: [] },
                usage: { inputTokens: 1, outputTokens: 1 },
            }),
        } as never);

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
        return { board, run: () => dispatcher.run('0001', 'implementing') };
    };

    it('flags the card where it failed on the first attempt, with that reason', async () => {
        const { board, run } = await setUp({
            passed: false,
            failures: ['src/a.ts:1 adds a suspected GitHub token'],
            changedPaths: ['src/a.ts'],
            needsHumanReason: 'possible credential at src/a.ts:1',
        });

        const outcome = await run();

        expect(outcome).toMatchObject({ passed: false, needsHuman: true, transitionedTo: 'implementing' });
        const { frontmatter } = await board.read('0001');
        expect(frontmatter.stage).toBe('implementing');
        expect(frontmatter.needsHumanReason).toBe('possible credential at src/a.ts:1');
    });

    it('routes an ordinary failure by onFail, unflagged', async () => {
        const { board, run } = await setUp({ passed: false, failures: ['the build broke'], changedPaths: [] });

        const outcome = await run();

        expect(outcome.needsHuman).toBeFalsy();
        expect((await board.read('0001')).frontmatter.stage).toBe('testing');
    });
});
