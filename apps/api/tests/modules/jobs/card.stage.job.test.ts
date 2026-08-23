import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';

const stagesYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: testing
    onFail: needs-human
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

describe('CardStageJob', () => {
    let board: BoardConfig;
    let dispatcher: { run: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let job: CardStageJob;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-'));
        const boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');

        board = new StaticBoardConfig('test', boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        dispatcher = { run: vi.fn(async () => outcome()) };
        broker = { send: vi.fn(async () => {}) };
        events = { append: vi.fn(async () => {}) };

        job = new CardStageJob(dispatcher as unknown as StageDispatcher, broker as unknown as JobBroker, board, events as unknown as EventLog);
    });

    it('does nothing when the dispatcher leaves the stage un-transitioned (a manual gate)', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: undefined }));

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(broker.send).not.toHaveBeenCalled();
        expect(events.append).not.toHaveBeenCalled();
    });

    it('enqueues the next stage when the card lands on another agent stage', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'testing' }));

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'testing' });
        expect(events.append).not.toHaveBeenCalled();
    });

    it('re-enqueues on a kickback to an earlier agent stage rather than treating it as terminal', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'implementing' }));

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing' });
    });

    it('stops and records a chain.stopped event when the card lands on a manual stage', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'review' }));

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(broker.send).not.toHaveBeenCalled();
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                project: 'test',
                cardId: '0001',
                stage: 'testing',
                type: 'chain.stopped',
                payload: { target: 'review', reason: expect.stringContaining('manual') },
            }),
        );
    });

    it('stops and records a chain.stopped event when the card lands on a terminal state', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'merged' }));

        await job.run({ cardId: '0001', stageName: 'review' });

        expect(broker.send).not.toHaveBeenCalled();
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'review',
                type: 'chain.stopped',
                payload: { target: 'merged', reason: expect.stringContaining('terminal state') },
            }),
        );
    });

    it('runs the requested stage through the dispatcher with the card id and stage name given', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: undefined }));

        await job.run({ cardId: '0042', stageName: 'implementing' });

        expect(dispatcher.run).toHaveBeenCalledWith('0042', 'implementing');
    });
});
