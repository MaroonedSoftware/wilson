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

const BLOCKER_PROBLEM = 'the loop bound is off by one';
const CONCERN_PROBLEM = 'the variable name is unclear';

/**
 * A config wiring `review.onFail: challenge`, `challenge.onPass: ready`, `challenge.onFail:
 * implementing` — exactly the routing card 0237's Constraints call for ("No dispatcher change.
 * Routing is config"). `implementing` and `ready` are never actually dispatched in this test; they
 * exist only so `assertRoutesResolve` (`stage.config.ts`) has somewhere real to point at.
 */
const stagesYaml = `
stages:
  - name: review
    mode: agent
    model: claude-opus
    instructions: review it
    worktreeFrom: branch
    onPass: merged
    onFail: challenge
    maxKickbacks: 3
  - name: challenge
    mode: agent
    model: claude-opus
    instructions: challenge it
    worktreeFrom: branch
    onPass: ready
    onFail: implementing
    maxKickbacks: 3
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

/**
 * Card 0237, AC8: a review that raises one blocker and one concern, followed by a challenge that
 * refutes the blocker and leaves the concern untouched, ends with the card in `ready` carrying only
 * the concern.
 *
 * Runs `StageDispatcher.run` twice against a real Postgres board and a real git worktree — the same
 * "real board, real git, stub agent" shape `stage.dispatcher.branch-recording.test.ts` uses — with
 * the actual `ReviewVerifier`/`ChallengeVerifier` pair wired in rather than a trivial stand-in: the
 * point of this test is that the new `challenge` stage's config-driven routing and its verifier's own
 * accounting rule (card 0237's Constraints) work together end to end, not just that each checks out
 * in isolation.
 */
describe("StageDispatcher runs review -> challenge -> ready when every blocker is refuted (card 0237's AC8)", () => {
    it('ends with the card in ready, its body carrying only the concern', async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-challenge-'));
        const codeRoot = join(base, 'code');
        await mkdir(join(codeRoot, 'src'), { recursive: true });
        // Git tracks files, not directories: without a tracked file already under `src/`, a fresh
        // worktree checkout has no `src` directory at all to write `changed.ts` into below.
        await writeFile(join(codeRoot, 'src', 'kept.ts'), 'export const kept = 1;\n', 'utf8');
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const project = uniqueProject();
        const config = new StaticBoardConfig(project, codeRoot, join(base, 'worktrees'), join(base, 'run'));
        const events = new EventLog(db, silentLogger as never);
        const board = new PostgresBoardRepository(config, db, events);
        const worktrees = new WorktreeManager(config, silentLogger as never);

        const seedCard: Card = {
            frontmatter: { id: '0001', title: 'fix the loop', stage: 'review', dependsOn: [], retries: {} },
            sections: { 'Files in scope': '- src/changed.ts' },
            body: '## Goal\n\nFix the loop.\n\n## Files in scope\n\n- src/changed.ts\n',
        };
        await board.create(seedCard, 'seed');

        // Stand in for the implementing/testing stages that would ordinarily have run first: a real
        // commit on the card's branch, so `ReviewVerifier`'s and `ChallengeVerifier`'s own provenance
        // checks have a genuine diff to check findings against.
        const branch = worktrees.resolveBranch(seedCard);
        const seedWorktree = await worktrees.create('0001', branch);
        await writeFile(join(seedWorktree.path, 'src', 'changed.ts'), 'a\nb\nc\nd\ne\n', 'utf8');
        await worktrees.commit(seedWorktree, 'implement the thing');
        await worktrees.reclaim('0001');

        const agents = new StageAgentMap();
        agents.set('api', {
            run: async (input): Promise<AgentRunOutput> => {
                if (input.stage.name === 'review') {
                    return {
                        result: {
                            summary: 'found a blocker and a concern',
                            verdict: 'revise',
                            findings: [
                                { severity: 'blocker', kind: 'defect', file: 'src/changed.ts', line: 2, problem: BLOCKER_PROBLEM, suggestion: 'fix the bound' },
                                { severity: 'concern', kind: 'defect', file: 'src/changed.ts', line: 3, problem: CONCERN_PROBLEM, suggestion: 'rename it' },
                            ],
                        },
                        usage: { inputTokens: 10 },
                        truncated: false,
                    };
                }
                if (input.stage.name === 'challenge') {
                    return {
                        result: {
                            summary: 'refuted the blocker, left the concern',
                            verdict: 'pass',
                            findings: [{ severity: 'concern', kind: 'defect', file: 'src/changed.ts', line: 3, problem: CONCERN_PROBLEM, suggestion: 'rename it' }],
                            refuted: [{ problem: BLOCKER_PROBLEM, reason: 'the bound is inclusive on purpose, per the plan' }],
                        },
                        usage: { inputTokens: 5 },
                        truncated: false,
                    };
                }
                throw new Error(`MARKER: unexpected stage dispatched in this test: ${input.stage.name}`);
            },
        });

        const reviewVerifier = new ReviewVerifier(worktrees, silentLogger as never);
        const challengeVerifier = new ChallengeVerifier(reviewVerifier, events, config);
        const verifiers = new StageVerifierMap();
        verifiers.set('review', reviewVerifier);
        verifiers.set('challenge', challengeVerifier);

        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('review', ReviewResultSchema);
        resultSchemas.set('challenge', ChallengeResultSchema);

        const dispatcher = new StageDispatcher(
            config,
            new StaticStageConfigStore(stagesYaml),
            board,
            worktrees,
            agents,
            verifiers,
            resultSchemas,
            events,
            silentLogger as never,
        );

        const reviewOutcome = await dispatcher.run('0001', 'review');
        expect(reviewOutcome.passed).toBe(true);
        expect(reviewOutcome.transitionedTo).toBe('challenge');

        const afterReview = await board.read('0001');
        expect(afterReview.frontmatter.stage).toBe('challenge');
        expect(afterReview.body).toContain(BLOCKER_PROBLEM);
        expect(afterReview.body).toContain(CONCERN_PROBLEM);

        const challengeOutcome = await dispatcher.run('0001', 'challenge');
        expect(challengeOutcome.passed).toBe(true);
        expect(challengeOutcome.failures).toEqual([]);
        expect(challengeOutcome.transitionedTo).toBe('ready');

        const afterChallenge = await board.read('0001');
        expect(afterChallenge.frontmatter.stage).toBe('ready');
        expect(afterChallenge.body).toContain('## Review findings');
        expect(afterChallenge.body).toContain(CONCERN_PROBLEM);
        expect(afterChallenge.body).not.toContain(BLOCKER_PROBLEM);
    });
});
