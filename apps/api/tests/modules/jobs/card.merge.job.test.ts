import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { BoardWriteService } from '#modules/board/board.write.service.js';
import type { EventLog } from '#modules/events/event.log.js';
import { CARD_MERGE_POLICY, CARD_MERGE_WORKER, CardMergeJob } from '#modules/jobs/card.merge.job.js';
import { DAILY_OUTPUT_TOKEN_CEILING } from '#modules/settings/daily.output.token.ceiling.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import { JobsModule } from '#modules/jobs/jobs.module.js';
import { MAX_STAGE_WALL_CLOCK_MS } from '#modules/stages/stage.config.js';
import { PgBossJobRegistryMap } from '@maroonedsoftware/jobbroker/pgboss';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import type { Identifier, Registry } from 'injectkit';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };

describe('CardMergeJob', () => {
    let writes: { merge: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn>; outputTokensSince: ReturnType<typeof vi.fn> };
    let frontmatter: { stage: string; needsHuman?: boolean };
    let ceiling: number;

    const run = () => {
        const settings = {
            get: vi.fn(async (setting: { key: string; defaultValue: unknown }) =>
                setting.key === DAILY_OUTPUT_TOKEN_CEILING.key ? ceiling : setting.defaultValue,
            ),
        };
        return new CardMergeJob(
            writes as unknown as BoardWriteService,
            new StaticBoardConfig('test', '/tmp/code', '/tmp/wt', '/tmp/run'),
            { read: vi.fn(async () => ({ frontmatter: { id: '0002', title: 'a card', ...frontmatter } })) } as unknown as BoardRepository,
            events as unknown as EventLog,
            settings as unknown as SettingsStore,
            logger as never,
        ).run({ cardId: '0002', project: 'test' });
    };

    const recorded = () => events.append.mock.calls.map(([event]) => ({ type: event.type, stage: event.stage, reason: event.payload.reason }));

    beforeEach(() => {
        writes = { merge: vi.fn(async () => ({ merged: true, commit: 'abc123' })) };
        events = { append: vi.fn(async () => {}), outputTokensSince: vi.fn(async () => 0) };
        frontmatter = { stage: 'ready' };
        ceiling = 0;
    });

    it('merges as the runner and records nothing extra on success', async () => {
        await run();

        expect(writes.merge).toHaveBeenCalledWith('0002', { by: 'runner' });
        expect(events.append).not.toHaveBeenCalled();
    });

    it('skips with a reason when the card has left ready', async () => {
        frontmatter = { stage: 'review' };

        await expect(run()).resolves.toBeUndefined();

        expect(writes.merge).not.toHaveBeenCalled();
        expect(recorded()).toEqual([{ type: 'card.merge-skipped', stage: 'ready', reason: '0002 is in "review", not "ready"' }]);
    });

    it('skips with a reason when the card is flagged for a human', async () => {
        frontmatter = { stage: 'ready', needsHuman: true };

        await run();

        expect(writes.merge).not.toHaveBeenCalled();
        expect(recorded()[0]).toEqual({ type: 'card.merge-skipped', stage: 'ready', reason: '0002 is flagged for a human' });
    });

    it('skips with a reason at the daily ceiling', async () => {
        ceiling = 100;
        events.outputTokensSince.mockResolvedValue(100);

        await run();

        expect(writes.merge).not.toHaveBeenCalled();
        expect(recorded()[0]?.reason).toContain('daily ceiling of 100');
    });

    it('records an unmerged result by its reason and does not fail the job', async () => {
        writes.merge.mockResolvedValue({ merged: false, reason: 'merge of card/0002 into main fails the suite: 1 failing' });

        await expect(run()).resolves.toBeUndefined();

        expect(writes.merge).toHaveBeenCalledWith('0002', { by: 'runner' });
        expect(recorded()).toEqual([
            { type: 'card.merge-skipped', stage: 'ready', reason: 'merge of card/0002 into main fails the suite: 1 failing' },
        ]);
    });

    it('records a thrown refusal by its reason and does not fail the job', async () => {
        writes.merge.mockRejectedValue(Object.assign(new Error('Bad Request'), { details: { reason: 'cannot merge 0002' } }));

        await expect(run()).resolves.toBeUndefined();

        expect(recorded()).toEqual([{ type: 'card.merge-skipped', stage: 'ready', reason: 'cannot merge 0002' }]);
    });

    it('records a thrown error by its message and does not fail the job', async () => {
        writes.merge.mockRejectedValue(new Error('git exploded'));

        await expect(run()).resolves.toBeUndefined();

        expect(recorded()).toEqual([{ type: 'card.merge-skipped', stage: 'ready', reason: 'git exploded' }]);
    });

    it('is never retried and runs one merge at a time', () => {
        expect(CARD_MERGE_POLICY.retryLimit).toBe(0);
        expect(CARD_MERGE_WORKER.concurrency).toBe(1);
    });

    it('expires no sooner than a full suite run could take', () => {
        expect(CARD_MERGE_POLICY.expiresIn!.toMillis()).toBeGreaterThanOrEqual(MAX_STAGE_WALL_CLOCK_MS);
    });
});

/** Card 0036: the poller's `card.merge` sends land on a registered queue with the job's own policies. */
describe('JobsModule.setup — card.merge', () => {
    it('registers card.merge with CardMergeJob, its policy and its one-at-a-time worker', async () => {
        const instances = new Map<unknown, unknown>();
        const lifetimes = { asSingleton: () => {}, asTransient: () => {}, asScoped: () => {} };
        const registry = {
            register: (id: Identifier<unknown>) => ({
                useFactory: () => lifetimes,
                useClass: () => lifetimes,
                useInstance: (value: unknown) => {
                    instances.set(id, value);
                    return lifetimes;
                },
            }),
        } as unknown as Registry;

        await JobsModule.setup!(registry, { get: () => 'unused' } as unknown as AppConfig);

        const jobRegistry = instances.get(PgBossJobRegistryMap) as PgBossJobRegistryMap;
        expect(jobRegistry.get('card.merge')).toEqual({ job: CardMergeJob, policy: CARD_MERGE_POLICY, worker: CARD_MERGE_WORKER });
    });
});
