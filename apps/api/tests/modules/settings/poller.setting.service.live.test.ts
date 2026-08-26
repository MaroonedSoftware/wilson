import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { Card, CardFrontmatter } from '#modules/board/card.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { Logger } from '@maroonedsoftware/logger';

/**
 * The acceptance criteria this card names for the poller setting are behavioural, not just "the
 * right method got called": setting it true "starts it, and a card becomes dispatchable without a
 * restart"; setting it to an already-set value "starts no second timer"; setting it false "stops
 * the timer; a stage already running is unaffected". `poller.setting.service.test.ts` proves
 * `PollerSettingService` delegates to `Poller.start`/`Poller.stop` correctly against fakes; this
 * file proves that delegation actually produces those three properties against the *real* `Poller`
 * (only its board/broker/cardJobs/logger collaborators and `SettingsStore` are fakes) — the same
 * "mock node:timers/promises, drive ticks by hand" technique `poller.test.ts` uses (see its own
 * comment for why `vi.useFakeTimers()` cannot reach `node:timers/promises`), applied through
 * `PollerSettingService.set` instead of `Poller.start`/`stop` directly.
 */
interface PendingDelay {
    resolve: () => void;
}
let pending: PendingDelay[] = [];

const delayMock = vi.fn((_ms: number, _value: undefined, opts: { signal: AbortSignal }) => {
    return new Promise<void>((resolve, reject) => {
        const entry: PendingDelay = {
            resolve: () => {
                opts.signal.removeEventListener('abort', onAbort);
                pending = pending.filter(p => p !== entry);
                resolve();
            },
        };
        const onAbort = () => {
            pending = pending.filter(p => p !== entry);
            reject(new Error('AbortError'));
        };
        if (opts.signal.aborted) {
            onAbort();
            return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
        pending.push(entry);
    });
});
vi.mock('node:timers/promises', () => ({ setTimeout: delayMock }));

const { Poller } = await import('#modules/jobs/poller.js');
const { PollerSettingService } = await import('#modules/settings/poller.setting.service.js');

const releaseTick = () => pending.shift()?.resolve();

const stagesYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: review
    onFail: implementing
  - name: review
    mode: manual
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: implementing
`;

let boardRoot: string;
beforeEach(async () => {
    boardRoot = await mkdtemp(join(tmpdir(), 'poller-setting-service-test-'));
    await mkdir(join(boardRoot, 'config'), { recursive: true });
    await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml);
    pending = [];
    delayMock.mockClear();
});
afterEach(async () => {
    for (const entry of [...pending]) entry.resolve();
    await rm(boardRoot, { recursive: true, force: true });
});

const card = (id: string, stage: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage, dependsOn: [], retries: {} } as CardFrontmatter,
    sections: {},
    body: '',
});

/** A `SettingsStore` fake, in-memory — real enough to drive `PollerSettingService`, no database needed here. */
const fakeSettingsStore = (): SettingsStore => {
    let enabled = false;
    return {
        get: async () => enabled,
        set: async (_definition: unknown, value: boolean) => {
            enabled = value;
        },
    } as unknown as SettingsStore;
};

const buildRealPoller = (cards: Card[]) => {
    const config = new StaticBoardConfig('poller-setting-live-test', boardRoot, '/tmp/code', '/tmp/wt', '/tmp/run');
    const board = { list: vi.fn(async () => cards) };
    const claims = new Map<string, string>();
    const cardJobs = {
        inFlight: vi.fn(async (cardId: string) => claims.get(cardId)),
        record: vi.fn(async (cardId: string, jobId: string) => {
            claims.set(cardId, jobId);
        }),
        clear: vi.fn(async () => {}),
    };
    const broker = { send: vi.fn(async () => 'job-1') };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const poller = new Poller(board as unknown as BoardRepository, config, broker as unknown as JobBroker, cardJobs as unknown as CardJobs, logger as unknown as Logger);
    return { poller, board, broker, cardJobs };
};

describe('PollerSettingService.set — turning the poller on with no restart', () => {
    it('setting poller-enabled true starts the real poller, and a tick then enqueues a dispatchable card', async () => {
        const { poller, broker, cardJobs } = buildRealPoller([card('0001', 'implementing')]);
        const service = new PollerSettingService(fakeSettingsStore(), poller);

        await service.set({ enabled: true });
        expect(pending).toHaveLength(1); // the poller is actually ticking now, not merely "recorded as on"

        releaseTick();
        await vi.waitFor(() => expect(broker.send).toHaveBeenCalledTimes(1));
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-1');
    });

    /**
     * Acceptance criterion: "Setting a value that is already set starts no second timer."
     */
    it('setting poller-enabled true a second time, while already true, starts no second timer', async () => {
        const { poller } = buildRealPoller([]);
        const service = new PollerSettingService(fakeSettingsStore(), poller);

        await service.set({ enabled: true });
        await service.set({ enabled: true });

        expect(pending).toHaveLength(1);
    });

    it('setting poller-enabled false stops the timer', async () => {
        const { poller, board } = buildRealPoller([card('0001', 'implementing')]);
        const service = new PollerSettingService(fakeSettingsStore(), poller);

        await service.set({ enabled: true });
        releaseTick();
        await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(1));

        await service.set({ enabled: false });

        expect(pending).toHaveLength(0);
    });

    /**
     * Acceptance criterion: "Setting it to false stops the timer; a stage already running is
     * unaffected, and a test asserts that rather than assuming it." `Poller.stop()`'s own contract
     * is to wait out a tick already in flight rather than abandon it mid-enqueue — this proves that
     * contract survives being reached through the settings write, not just through `Poller.stop()`
     * called directly.
     */
    it('turning it off waits out an enqueue already in flight rather than abandoning it', async () => {
        let releaseList: (() => void) | undefined;
        const cards = [card('0001', 'implementing')];
        const config = new StaticBoardConfig('poller-setting-live-test', boardRoot, '/tmp/code', '/tmp/wt', '/tmp/run');
        const board = {
            list: vi.fn(
                () =>
                    new Promise<Card[]>(resolve => {
                        releaseList = () => resolve(cards);
                    }),
            ),
        };
        const claims = new Map<string, string>();
        const cardJobs = {
            inFlight: vi.fn(async (cardId: string) => claims.get(cardId)),
            record: vi.fn(async (cardId: string, jobId: string) => {
                claims.set(cardId, jobId);
            }),
            clear: vi.fn(async () => {}),
        };
        const broker = { send: vi.fn(async () => 'job-1') };
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        const poller = new Poller(board as unknown as BoardRepository, config, broker as unknown as JobBroker, cardJobs as unknown as CardJobs, logger as unknown as Logger);
        const service = new PollerSettingService(fakeSettingsStore(), poller);

        await service.set({ enabled: true });
        releaseTick();
        await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(1));

        const offPromise = service.set({ enabled: false });
        // The in-flight tick is still blocked inside board.list(), so it cannot have enqueued yet.
        expect(broker.send).not.toHaveBeenCalled();

        releaseList!();
        await offPromise;

        expect(broker.send).toHaveBeenCalledTimes(1);
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-1');
    });
});
