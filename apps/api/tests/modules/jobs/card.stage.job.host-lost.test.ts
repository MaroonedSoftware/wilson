import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { Duration } from 'luxon';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { EventLog } from '#modules/events/event.log.js';
import { HostLostError } from '#modules/host/placement.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import { CardStageJob, hostLossDelay, MAX_HOST_LOSSES } from '#modules/jobs/card.stage.job.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import type { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { defaultSettings } from '#tests/support/fake.settings.js';

const lost = new HostLostError('my-mac', 'no answer to a keepalive ping in 60s');

describe('CardStageJob when a stage loses its host', () => {
    let dispatcher: { run: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let boardRepo: { write: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; writeWithEvent: ReturnType<typeof vi.fn> };
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; inFlight: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let job: CardStageJob;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-host-lost-'));
        dispatcher = {
            run: vi.fn(async () => {
                throw lost;
            }),
        };
        broker = { send: vi.fn(async () => 'job-2') };
        events = { append: vi.fn(async () => {}) };
        boardRepo = {
            write: vi.fn(async () => 'sha'),
            read: vi.fn(async () => {
                throw new Error('not stubbed');
            }),
            writeWithEvent: vi.fn(async () => 'sha'),
        };
        cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };
        job = new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            new StaticBoardConfig('test', join(base, 'code'), join(base, 'worktrees'), join(base, 'run')),
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
            new StaticStageConfigStore('stages: []\n'),
            defaultSettings,
        );
    });

    it('sends the stage again and completes this job, so no retry is spent', async () => {
        await expect(job.run({ cardId: '0001', stageName: 'testing' })).resolves.toBeUndefined();

        expect(broker.send).toHaveBeenCalledWith(
            'card.stage',
            expect.objectContaining({ cardId: '0001', stageName: 'testing', hostLosses: 1 }),
            expect.objectContaining({ startAfter: hostLossDelay(1) }),
        );
    });

    it('moves the claim to the new job rather than releasing it', async () => {
        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-2');
        expect(cardJobs.clear).not.toHaveBeenCalled();
    });

    it('does not poison, kick back or write to the card', async () => {
        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(boardRepo.write).not.toHaveBeenCalled();
        expect(boardRepo.writeWithEvent).not.toHaveBeenCalled();
        expect(events.append.mock.calls.map(call => call[0].type)).not.toContain('stage.poisoned');
    });

    it('counts up from the loss the job was given, and keeps its step', async () => {
        await job.run({ cardId: '0001', stageName: 'planning', step: 'scope-check', hostLosses: 2 });

        expect(broker.send.mock.calls[0]![1]).toMatchObject({ hostLosses: 3, step: 'scope-check' });
    });

    it('keeps where an interrupted stage left off', async () => {
        const interrupted = { baseSha: 'abc', host: 'my-mac' };

        await job.run({ cardId: '0001', stageName: 'testing', interrupted });

        expect(broker.send.mock.calls[0]![1]).toMatchObject({ interrupted });
    });

    it('flags the card for a person at the limit, leaving it in its stage with no job queued', async () => {
        await job.run({ cardId: '0001', stageName: 'testing', hostLosses: MAX_HOST_LOSSES - 1 });

        expect(broker.send).not.toHaveBeenCalled();
        expect(cardJobs.clear).toHaveBeenCalledWith('0001');
        expect(events.append.mock.calls.map(call => call[0].type)).not.toContain('stage.poisoned');

        const [, , mutate, event] = boardRepo.writeWithEvent.mock.calls[0]!;
        const card = { frontmatter: { title: 't', stage: 'testing', retries: { testing: 1 } } };
        expect(mutate(card).frontmatter).toEqual({
            ...card.frontmatter,
            needsHuman: true,
            needsHumanReason: expect.stringContaining(`lost its host ${MAX_HOST_LOSSES} times in a row, most recently my-mac`),
        });
        expect(event).toMatchObject({ stage: 'testing', payload: { to: 'testing', needsHuman: true } });
    });

    it('still lets the queue retry any other transient failure', async () => {
        dispatcher.run = vi.fn(async () => {
            throw new Error('socket hang up');
        });

        await expect(job.run({ cardId: '0001', stageName: 'testing' })).rejects.toThrow('socket hang up');
        expect(broker.send).not.toHaveBeenCalled();
    });
});

describe('hostLossDelay', () => {
    const seconds = (delay: Duration) => delay.as('seconds');

    it('doubles from 30 seconds and stops at 5 minutes', () => {
        expect([1, 2, 3, 4, 5, 6].map(losses => seconds(hostLossDelay(losses)))).toEqual([30, 60, 120, 240, 300, 300]);
    });
});
