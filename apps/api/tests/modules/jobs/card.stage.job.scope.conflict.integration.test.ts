import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { Logger } from '@maroonedsoftware/logger';
import type { Kysely } from 'kysely';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import type { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';
import type { DB } from '#modules/data/db.js';

/**
 * Card 0104. Every other test of `deferOnScopeConflict` (card.stage.job.test.ts) mocks
 * `boardRepo.scopeConflict` directly, and every test of `BoardRepository.scopeConflict`
 * (postgres.board.repository.test.ts) calls it directly, never through a dispatch. Neither proves
 * the two are actually wired together correctly — the argument order `CardStageJob` passes, the
 * project name, the stage config it loads. This file is the seam: a real `PostgresBoardRepository`
 * and a real `EventLog` against the test database, driven by `CardStageJob.run` exactly as a poller
 * or `wilson card start` enqueue would, with only the dispatcher, broker and card-claim tracker left
 * as stand-ins (what actually runs a stage is not what this card changed).
 */

const silentLogger: Logger = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
};

const stagesYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: testing
    onFail: implementing
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: review
    onFail: implementing
  - name: review
    mode: manual
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: implementing
`;

const outcome = (overrides: Partial<StageOutcome> = {}): StageOutcome => ({
    passed: true,
    failures: [],
    changedPaths: [],
    scopeGrants: [],
    ...overrides,
});

const card = (id: string, stage: string, filesInScope: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage, dependsOn: [], retries: {} },
    sections: {},
    body: `## Files in scope\n\n- ${filesInScope}\n`,
});

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('CardStageJob deferring on a real BoardRepository scope conflict (card 0104)', () => {
    const buildJob = async (): Promise<{
        job: CardStageJob;
        project: string;
        events: EventLog;
        boardRepo: PostgresBoardRepository;
        dispatcher: { run: ReturnType<typeof vi.fn> };
    }> => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-scope-conflict-integration-'));
        const boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');

        const project = uniqueProject();
        const board: BoardConfig = new StaticBoardConfig(project, boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = new EventLog(db, silentLogger);
        const boardRepo = new PostgresBoardRepository(board, db, events);

        const dispatcher = { run: vi.fn(async () => outcome()) };
        const broker = { send: vi.fn(async () => 'job-1') };
        const cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };

        const job = new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            board,
            boardRepo,
            events,
            cardJobs as unknown as CardJobs,
        );

        return { job, project, events, boardRepo, dispatcher };
    };

    it('defers a real dispatch when the two cards on the board genuinely overlap, and never calls the dispatcher', async () => {
        const { job, project, events, boardRepo, dispatcher } = await buildJob();

        await boardRepo.create(card('0001', 'implementing', 'apps/api/src/modules/events/card.event.ts'), 'create');
        await boardRepo.create(card('0002', 'implementing', 'apps/api/src/modules/events/card.event.ts'), 'create');
        // Card 0128: sitting in `implementing` is no longer sufficient by itself — 0001 must actually
        // be carried by a job, the same live claim a real `CardJobs.record` would leave behind.
        await db.insertInto('runner.cardJobs').values({ project, cardId: '0001', jobId: 'external-job-1' }).execute();

        await job.run({ cardId: '0002', stageName: 'implementing' });

        expect(dispatcher.run).not.toHaveBeenCalled();

        const rows = await events.tail(project, '0002', 100);
        const deferred = rows.find(r => r.type === 'dispatch.deferred');
        expect(deferred?.payload).toEqual({
            outstanding: ['0001'],
            reason: '0002 deferred: apps/api/src/modules/events/card.event.ts is in flight on 0001',
        });

        // No board write happened underneath the defer: the card sits exactly where it started.
        expect((await boardRepo.read('0002')).frontmatter.stage).toBe('implementing');
    });

    it('dispatches normally through the real repository when nothing on the board overlaps', async () => {
        const { job, project, events, boardRepo, dispatcher } = await buildJob();

        await boardRepo.create(card('0001', 'implementing', 'apps/api/src/a.ts'), 'create');
        await boardRepo.create(card('0002', 'implementing', 'apps/api/src/b.ts'), 'create');

        await job.run({ cardId: '0002', stageName: 'implementing' });

        expect(dispatcher.run).toHaveBeenCalledWith('0002', 'implementing');
        const rows = await events.tail(project, '0002', 100);
        expect(rows.map(r => r.type)).not.toContain('dispatch.deferred');
    });

    /**
     * Card 0128, through the real stack: two cards sitting in the same agent stage with overlapping
     * scope, neither one actually carried by a job — the exact shape that gridlocked the board (0024
     * and 0041 each deferred on the other, holding no claim). Before this card, `deferOnScopeConflict`
     * would defer this dispatch forever on stage membership alone; now it must go through.
     */
    it('dispatches normally when two overlapping cards are merely parked in an agent stage with no live claim on either side (the gridlock)', async () => {
        const { job, project, events, boardRepo, dispatcher } = await buildJob();

        await boardRepo.create(card('0001', 'implementing', 'apps/api/src/modules/events/card.event.ts'), 'create');
        await boardRepo.create(card('0002', 'implementing', 'apps/api/src/modules/events/card.event.ts'), 'create');

        await job.run({ cardId: '0002', stageName: 'implementing' });

        expect(dispatcher.run).toHaveBeenCalledWith('0002', 'implementing');
        const rows = await events.tail(project, '0002', 100);
        expect(rows.map(r => r.type)).not.toContain('dispatch.deferred');
    });
});
