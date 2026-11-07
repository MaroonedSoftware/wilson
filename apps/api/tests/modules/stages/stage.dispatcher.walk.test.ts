import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { ReviewResultSchema, StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { ReviewVerifier } from '#modules/stages/review.verifier.js';
import { WalkResultSchema, WalkVerifier } from '#modules/stages/walk.verifier.js';
import type { Card } from '#modules/board/card.js';
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

const stagesYaml = `
stages:
  - name: review
    mode: agent
    model: claude-opus
    instructions: review it
    worktreeFrom: branch
    onPass: ready
    onFail: implementing
    maxKickbacks: 3
    steps:
      - name: walk
        on: pass
        instructions: start the app and walk the path
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: merged
    onFail: implementing
  - name: ready
    mode: manual
    model: claude-opus
    instructions: human gate
    onPass: merged
    onFail: ready
`;

const BLANK = 'the answer box never appears';

/** A review lane with a `pass` step, end to end: the walk runs after the review passes and decides where the card goes. */
describe('StageDispatcher walks the path after a review passes', () => {
    const setUp = async (walkResult: unknown) => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-walk-'));
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
        const seed: Card = {
            frontmatter: { id: '0001', title: 'answer box', stage: 'review', dependsOn: [], retries: {} },
            sections: { 'Files in scope': '- src/page.tsx' },
            body: '## Goal\n\nShow an answer box.\n\n## Files in scope\n\n- src/page.tsx\n',
        };
        await board.create(seed, 'seed');
        const seeded = await worktrees.create('0001', worktrees.resolveBranch(seed));
        await writeFile(join(seeded.path, 'src', 'page.tsx'), 'a\nb\nc\n', 'utf8');
        await worktrees.commit(seeded, 'implement');
        await worktrees.reclaim('0001');

        const agents = new StageAgentMap();
        agents.set('api', {
            run: async ({ stage }): Promise<AgentRunOutput> =>
                stage.step === 'walk'
                    ? { result: walkResult, truncated: false }
                    : { result: { summary: 'looks right', verdict: 'pass', findings: [] }, truncated: false },
        });
        const verifiers = new StageVerifierMap();
        verifiers.set('review', new ReviewVerifier(worktrees, silentLogger as never));
        verifiers.set('walk', new WalkVerifier(worktrees));
        const schemas = new StageResultSchemaMap();
        schemas.set('review', ReviewResultSchema);
        schemas.set('walk', WalkResultSchema);
        const dispatcher = new StageDispatcher(
            config,
            new StaticStageConfigStore(stagesYaml),
            board,
            worktrees,
            agents,
            verifiers,
            schemas,
            events,
            silentLogger as never,
        );
        return { dispatcher, board };
    };

    const step = { action: 'opened the card', expected: 'an answer box', observed: 'an answer box', ok: true };

    it('holds the card in review for the walk, then sends it to ready when the walk passes', async () => {
        const { dispatcher, board } = await setUp({ summary: 'walked', path: 'open the card', steps: [step], verdict: 'pass' });

        const reviewed = await dispatcher.run('0001', 'review');
        expect(reviewed).toMatchObject({ transitionedTo: 'review', nextStep: 'walk' });

        const walked = await dispatcher.run('0001', 'review', undefined, 'walk');
        expect(walked.failures).toEqual([]);
        expect(walked.transitionedTo).toBe('ready');
        expect((await board.read('0001')).frontmatter.retries).toEqual({});
    });

    it('sends the card back with the walk’s blocker when the path does not deliver', async () => {
        const { dispatcher, board } = await setUp({
            summary: 'blank',
            path: 'open the card',
            steps: [{ ...step, observed: 'a blank page', ok: false }],
            verdict: 'revise',
            findings: [{ severity: 'blocker', kind: 'omission', file: 'src/page.tsx', problem: BLANK, suggestion: 'render it' }],
        });

        await dispatcher.run('0001', 'review');
        const walked = await dispatcher.run('0001', 'review', undefined, 'walk');

        expect(walked.transitionedTo).toBe('implementing');
        const card = await board.read('0001');
        expect(card.body).toContain(BLANK);
        expect(card.frontmatter.retries).toEqual({ review: 1 });
    });
});
