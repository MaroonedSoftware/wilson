import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap, type StageVerifier } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/** Polls rather than sleeping a fixed amount, so the test tracks real async progress, not a guess at it. */
const waitFor = async (predicate: () => boolean, timeoutMs = 10000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

const makeCard = (id: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'testing', dependsOn: [], retries: {} },
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
});

/**
 * Card 0081 (second pass): once `pnpmStoreLock` is actually contended between two dispatched stages,
 * `StageDispatcher` now folds the wait into the `worktree.prepared` event's `installWaitedMs` field —
 * a durable record alongside the log line the lock already emitted, so an operator does not have to
 * have been watching logs live to know a stage's setup queued behind another's.
 *
 * This exercises the real thing rather than a stand-in: two cards' `setupCommand`s race the *same*
 * `pnpmStoreLock` singleton `stage.dispatcher.ts` imports, through two real `StageDispatcher.run`
 * calls. `setupCommand` is a script that blocks until a release file appears, so the test controls
 * exactly when the lock's holder finishes — released only once the logger has actually observed the
 * second card's stage log that it is waiting, so the contention is real, not assumed from timing.
 */
describe('StageDispatcher records installWaitedMs on a genuinely contended setupCommand', () => {
    it('carries installWaitedMs only for the stage that had to queue behind the other, not the one that ran uncontended', async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-install-wait-'));
        const boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'cards'), { recursive: true });
        await mkdir(join(boardRoot, 'config'), { recursive: true });

        const startedPath = join(base, 'started');
        const releasePath = join(base, 'release');
        const scriptPath = join(base, 'setup.js');
        await writeFile(
            scriptPath,
            [
                "const fs = require('fs');",
                `fs.writeFileSync(${JSON.stringify(startedPath)}, 'x');`,
                `const deadline = Date.now() + 9000;`,
                `while (!fs.existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) { /* busy-wait for the test's release signal */ }`,
                'process.exit(0);',
            ].join('\n'),
            'utf8',
        );

        const stagesYaml = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: testing
    setupCommand: node ${scriptPath}
`;
        await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);

        const cardA = makeCard('0001');
        const cardB = makeCard('0002');
        await board.create(cardA, 'initial');
        await board.create(cardB, 'initial');

        const worktreeDirs: Record<string, string> = {
            '0001': join(base, 'wt-0001'),
            '0002': join(base, 'wt-0002'),
        };
        await mkdir(worktreeDirs['0001'], { recursive: true });
        await mkdir(worktreeDirs['0002'], { recursive: true });

        const worktrees = {
            resolveBranch: vi.fn((card: Card) => `card/${card.frontmatter.id}-do-the-thing`),
            hasWork: vi.fn(async () => false),
            create: vi.fn(async (cardId: string) => ({ path: worktreeDirs[cardId], baseSha: 'deadbeef' })),
            resume: vi.fn(async () => {
                throw new Error('MARKER: should not resume — hasWork returned false');
            }),
            rebaseOntoHead: vi.fn(async () => {
                throw new Error('MARKER: should not rebase — the run is not resumable');
            }),
            commit: vi.fn(async () => 'committedsha'),
            reclaim: vi.fn(async () => {}),
            // Card 0161: `run` now calls this unconditionally, once per board card, to grant read
            // access to every preserved patch — not just on a failure path.
            failedAttemptPatchPath: vi.fn((cardId: string) => `/tmp/run/cards/${cardId}/last-failed-attempt.patch`),
        };

        const agents = new StageAgentMap();
        agents.set('api', {
            run: async (): Promise<AgentRunOutput> => ({
                result: { summary: 'did the thing', caveats: [] },
                usage: { inputTokens: 10 },
                truncated: false,
            }),
        });
        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) };
        verifiers.set('testing', verifier);
        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('testing', {} as never);

        const logMessages: string[] = [];
        const logger = {
            info: (message: string) => {
                logMessages.push(message);
            },
            warn: () => {},
            error: () => {},
            debug: () => {},
        };

        const dispatcher = new StageDispatcher(
            config,
            board,
            worktrees as unknown as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            events as unknown as EventLog,
            logger as never,
        );

        const runA = dispatcher.run('0001', 'testing');
        // Card A's setupCommand only writes `startedPath` once `pnpmStoreLock` has actually granted
        // it the lock (that write happens inside the locked `fn`), so this proves A holds the lock
        // uncontended before B is even dispatched.
        await waitFor(() => existsSync(startedPath));

        const runB = dispatcher.run('0002', 'testing');
        // Wait for the lock's own contended-acquire log line, naming card B's setup as the one
        // waiting — not a fixed sleep, so this can never release A before B has genuinely queued.
        await waitFor(() => logMessages.some(message => message.includes('0002 testing setup waiting for the pnpm store lock')));

        writeFileSync(releasePath, 'go');

        const [resultA, resultB] = await Promise.all([runA, runB]);
        expect(resultA.passed).toBe(true);
        expect(resultB.passed).toBe(true);

        const preparedEventFor = (cardId: string) =>
            events.append.mock.calls.map(([event]) => event as { cardId: string; type: string; payload: Record<string, unknown> }).find(
                event => event.cardId === cardId && event.type === 'worktree.prepared',
            );

        const preparedA = preparedEventFor('0001');
        const preparedB = preparedEventFor('0002');

        expect(preparedA?.payload.ok).toBe(true);
        expect(preparedB?.payload.ok).toBe(true);

        // A never contended for the lock — nothing else was dispatched when it started — so its
        // event carries no installWaitedMs at all, not even a zero.
        expect(preparedA?.payload.installWaitedMs).toBeUndefined();

        // B genuinely queued behind A until the release file appeared, so its worktree.prepared event
        // must carry that wait as a real, durable figure — not just the log line the lock also emits.
        expect(typeof preparedB?.payload.installWaitedMs).toBe('number');
        expect(preparedB!.payload.installWaitedMs as number).toBeGreaterThan(0);
    });
});
