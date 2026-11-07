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
import { StageResultSchemaMap, ChallengeResultSchema, ReviewResultSchema } from '#modules/stages/stage.result.js';
import { ReviewVerifier } from '#modules/stages/review.verifier.js';
import { ChallengeVerifier } from '#modules/stages/challenge.verifier.js';
import { withFindings } from '#modules/board/append.findings.js';
import { DEMOTED_PREFIX } from '#modules/stages/frozen.scope.js';
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
      - name: challenge
        on: revise
        instructions: challenge it
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

const PLAN = '## Goal\n\nFix the loop.\n\n## Files in scope\n\n- src/changed.ts\n';
const NEW_PROBLEM = 'a name nobody raised before is unclear';

/**
 * A second review of a card, end to end on a real board and a real tree: a blocker that gives no
 * reason it may still block is kept as a concern, so the card goes on to `ready` without a challenge
 * and without spending a kickback.
 */
describe('StageDispatcher holds a later review to the scope its first set', () => {
    const run = async (body: string, finding: Record<string, unknown>) => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-frozen-'));
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
            frontmatter: { id: '0001', title: 'fix the loop', stage: 'review', dependsOn: [], retries: {} },
            sections: { 'Files in scope': '- src/changed.ts' },
            body,
        };
        await board.create(seed, 'seed');
        const seeded = await worktrees.create('0001', worktrees.resolveBranch(seed));
        await writeFile(join(seeded.path, 'src', 'changed.ts'), 'a\nb\nc\nd\ne\n', 'utf8');
        await worktrees.commit(seeded, 'implement the thing');
        await worktrees.reclaim('0001');

        const agents = new StageAgentMap();
        agents.set('api', {
            run: async (input): Promise<AgentRunOutput> => {
                if (input.stage.step) throw new Error(`MARKER: the ${input.stage.step} step should not run`);
                return {
                    result: {
                        summary: 'one more',
                        verdict: 'revise',
                        findings: [{ kind: 'defect', file: 'src/changed.ts', line: 2, suggestion: 'x', ...finding }],
                    },
                    usage: { inputTokens: 10 },
                    truncated: false,
                };
            },
        });
        const reviewVerifier = new ReviewVerifier(worktrees, silentLogger as never);
        const verifiers = new StageVerifierMap();
        verifiers.set('review', reviewVerifier);
        verifiers.set('challenge', new ChallengeVerifier(reviewVerifier, events, config));
        const schemas = new StageResultSchemaMap();
        schemas.set('review', ReviewResultSchema);
        schemas.set('challenge', ChallengeResultSchema);

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
        const outcome = await dispatcher.run('0001', 'review');
        return { outcome, card: await board.read('0001') };
    };

    const earlier = withFindings(PLAN, [
        { severity: 'blocker', kind: 'defect', file: 'src/changed.ts', line: 1, problem: 'the loop bound is off by one', suggestion: 'fix it' },
    ]);

    it('sends a later review’s basis-less blocker on to ready as a concern', async () => {
        const { outcome, card } = await run(earlier, { severity: 'blocker', problem: NEW_PROBLEM });

        expect(outcome.transitionedTo).toBe('ready');
        expect(card.frontmatter.retries).toEqual({});
        expect(card.body).toContain(`**concern** \`src/changed.ts:2\`: ${DEMOTED_PREFIX}${NEW_PROBLEM}`);
    });

    it('still sends a first review’s blocker to its challenge', async () => {
        const { outcome } = await run(PLAN, { severity: 'blocker', problem: NEW_PROBLEM });

        expect(outcome.transitionedTo).toBe('review');
        expect(outcome.nextStep).toBe('challenge');
    });

    it('still sends a later blocker that names its reason to the challenge', async () => {
        const { outcome } = await run(earlier, { severity: 'blocker', problem: 'the bound is still off', basis: 'unfixed' });

        expect(outcome.nextStep).toBe('challenge');
    });
});
