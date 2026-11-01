import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectScopedBoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { Card, CardFrontmatter } from '#modules/board/card.js';
import type { ProjectRepository, ProjectRow } from '#modules/board/project.repository.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import { POLLER_INTERVAL_MS } from '#modules/settings/poller.interval.setting.js';
import { DAILY_OUTPUT_TOKEN_CEILING } from '#modules/settings/daily.output.token.ceiling.setting.js';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { Logger } from '@maroonedsoftware/logger';
import type { DateTime } from 'luxon';

/**
 * Card 0049. `Poller.loop` waits on `node:timers/promises`' `setTimeout` (aliased `delay` in
 * poller.ts) between ticks, with the running `AbortSignal` passed through so `stop()` can cancel a
 * wait in progress. Real `node:timers/promises` `setTimeout` is not intercepted by
 * `vi.useFakeTimers()` (see `shutdown.faketimer.test.ts`), so — exactly as that file does — the
 * module itself is mocked here with a version this suite drives by hand: each call returns a promise
 * that stays pending until the test releases it, or rejects the moment its signal aborts, mirroring
 * the real function's own abort behaviour. This lets the `start`/`stop`/interval-loop tests below
 * control exactly when a tick fires without waiting out (or faking) the real 30s production
 * interval, and without needing to know `POLLER_INTERVAL_MS`'s value at all.
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
const { POLLER_INTERVAL_MS_DEFAULT } = await import('#modules/jobs/job.runner.config.js');

/** Release the oldest outstanding interval wait, letting the loop run one more tick. */
const releaseTick = () => pending.shift()?.resolve();

// A minimal but valid stage config: `implementing` is an agent stage (dispatchable), `review` and
// `ready` are manual (never dispatched), `triage` is a `command` stage (also never dispatched —
// card 0117's poller treats any non-`agent` mode the same way, `ready` included). `backlog` and
// `scope-check` exist for card 0127: `backlog` is manual with `onPass: scope-check` — deliberately
// not the more obvious `implementing`, so a poller that hard-coded a target instead of reading
// `onPass` from config would still pass every other test here but fail the ones that check it lands
// on `scope-check`. A `StaticStageConfigStore` parses this for real — the config is not mocked — so
// `whyNotDispatchable`'s stage lookup and `findStage(stages, 'backlog').onPass` inside `Poller.tick`
// are both exercised exactly as they run in production.
const stagesYaml = `
stages:
  - name: backlog
    mode: manual
    model: claude-opus
    instructions: read the plan
    onPass: scope-check
    onFail: backlog
  - name: scope-check
    mode: agent
    model: claude-opus
    instructions: check the scope
    onPass: implementing
    onFail: backlog
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
  - name: ready
    mode: manual
    model: claude-opus
    instructions: ready to merge
    onPass: merged
    onFail: ready
  - name: triage
    mode: command
    model: claude-opus
    instructions: triage it
    onPass: implementing
    onFail: triage
`;

const stageConfigs = new StaticStageConfigStore(stagesYaml);

let boardRoot: string;
beforeEach(async () => {
    boardRoot = await mkdtemp(join(tmpdir(), 'poller-test-'));
    pending = [];
    delayMock.mockClear();
});
afterEach(async () => {
    await rm(boardRoot, { recursive: true, force: true });
});

const card = (id: string, stage: string, overrides: Partial<CardFrontmatter> = {}): Card => ({
    frontmatter: { id, title: `card ${id}`, stage, dependsOn: [], retries: {}, ...overrides } as CardFrontmatter,
    sections: {},
    body: '',
});

/** A `CardJobs` fake that actually remembers claims, so `inFlight` reflects a prior `record` the way the real one does. */
type FakeCardJobs = { inFlight: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
const statefulCardJobs = (initial: Record<string, string> = {}): FakeCardJobs => {
    const claims = new Map(Object.entries(initial));
    return {
        inFlight: vi.fn(async (cardId: string) => claims.get(cardId)),
        record: vi.fn(async (cardId: string, jobId: string) => {
            claims.set(cardId, jobId);
        }),
        clear: vi.fn(async (cardId: string) => {
            claims.delete(cardId);
        }),
    };
};

const fakeBroker = (jobId = 'job-1') => ({ send: vi.fn(async () => jobId) });
const fakeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

/**
 * A `SettingsStore` fake for `POLLER_INTERVAL_MS` (card 0115: `Poller.loop` now reads it fresh every
 * iteration rather than closing over a constant): resolves any definition to its own coded default,
 * keyed by `key` so a second setting asked through the same fake would not collide with this one.
 */
const fakeSettingsStore = (): SettingsStore =>
    ({
        get: vi.fn(async (definition: { defaultValue: unknown }) => definition.defaultValue),
        set: vi.fn(async () => undefined),
    }) as unknown as SettingsStore;

/**
 * A `BoardRepository.scopeConflict` fake for card 0128: defaults to "no conflict, ever" so every
 * pre-existing test above keeps its old behaviour, and a caller wanting a candidate to defer passes
 * its own via `deps.scopeConflict`.
 */
const noConflict = vi.fn(async () => undefined);

const fakeEvents = () => ({}) as unknown as EventLog;

/**
 * Card 0264: `tickProject` now reads a second setting, `DAILY_OUTPUT_TOKEN_CEILING`, through the same
 * `SettingsStore.get` the "interval read survives a database outage" tests below already drive by
 * hand-queuing a sequence of resolved/rejected values — a sequence that was written assuming exactly
 * one `.get()` call per loop iteration, for `POLLER_INTERVAL_MS` alone. `failingIntervalSettings` and
 * `intervalReadSequence` keep that assumption true for those tests specifically: only a
 * `POLLER_INTERVAL_MS` read ever consults the queue or the forced failure; every other definition —
 * the ceiling among them — resolves its own coded default (0, meaning no ceiling) so `tickProject`
 * always finds nothing to enforce and these tests keep proving exactly what they always have about the
 * interval read, undisturbed by the second setting `tickProject` now also asks about.
 */
const failingIntervalSettings = (error: Error): SettingsStore =>
    ({
        get: vi.fn(async (definition: { key: string; defaultValue: unknown }) => {
            if (definition.key === POLLER_INTERVAL_MS.key) throw error;
            return definition.defaultValue;
        }),
        set: vi.fn(async () => undefined),
    }) as unknown as SettingsStore;

const intervalReadSequence = (...steps: Array<{ value: number } | { error: Error }>): SettingsStore => {
    const queue = [...steps];
    return {
        get: vi.fn(async (definition: { key: string; defaultValue: unknown }) => {
            if (definition.key !== POLLER_INTERVAL_MS.key) return definition.defaultValue;
            const step = queue.shift();
            if (!step) throw new Error('intervalReadSequence exhausted — add another step');
            if ('error' in step) throw step.error;
            return step.value;
        }),
        set: vi.fn(async () => undefined),
    } as unknown as SettingsStore;
};

const buildPoller = (
    cards: Card[],
    deps: Partial<{
        cardJobs: FakeCardJobs;
        broker: ReturnType<typeof fakeBroker>;
        logger: ReturnType<typeof fakeLogger>;
        settings: SettingsStore;
        scopeConflict: ReturnType<typeof vi.fn>;
        // Card 0264: overridable so the daily-ceiling tests below can hand `tickProject` a real
        // `outputTokensSince`; every other caller keeps `fakeEvents()`'s bare `{}`, which would throw
        // if that method were ever reached — proof by survival that a ceiling of 0 never calls it.
        events: EventLog;
    }> = {},
) => {
    const config = new StaticBoardConfig('poller-test-project', '/tmp/code', '/tmp/wt', '/tmp/run');
    const scopeConflict = deps.scopeConflict ?? noConflict;
    const board = {
        list: vi.fn(async () => cards),
        writeWithEvent: vi.fn<BoardRepository['writeWithEvent']>(async () => 'card-version-1'),
        scopeConflict,
    };
    const cardJobs = deps.cardJobs ?? statefulCardJobs();
    const broker = deps.broker ?? fakeBroker();
    const logger = deps.logger ?? fakeLogger();
    const settings = deps.settings ?? fakeSettingsStore();
    const events = deps.events ?? fakeEvents();
    const poller = new Poller(
        board as unknown as BoardRepository,
        config,
        stageConfigs,
        broker as unknown as JobBroker,
        cardJobs as unknown as CardJobs,
        logger as unknown as Logger,
        settings,
        events,
    );
    return { poller, board, cardJobs, broker, logger, settings, events };
};

/** Reach the private `tick()` directly: one tick, deterministically, with no interval/timer involved at all. */
const runOneTick = (poller: InstanceType<typeof Poller>): Promise<void> => (poller as unknown as { tick: () => Promise<void> }).tick();

describe('POLLER_INTERVAL_MS_DEFAULT', () => {
    it('is 30 seconds', () => {
        expect(POLLER_INTERVAL_MS_DEFAULT).toBe(30_000);
    });
});

describe('Poller tick — what it will and will not enqueue', () => {
    it('enqueues the one dispatchable card, sending to the broker before recording the claim', async () => {
        const { poller, broker, cardJobs, logger } = buildPoller([card('0001', 'implementing')]);

        await runOneTick(poller);

        // Card 0149: every enqueue now names the project it dispatches against — see the Poller
        // multi-project describe block below for the case where that field actually differs.
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing', project: 'poller-test-project' });
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-1');
        expect(broker.send.mock.invocationCallOrder[0]!).toBeLessThan(cardJobs.record.mock.invocationCallOrder[0]!);
        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.info.mock.calls[0]![0]).toContain('0001');
    });

    /**
     * The single most important check this card adds: a card something is already carrying must
     * never be enqueued a second time, or two agents end up on the same branch.
     */
    it('does not enqueue a card that already holds a live claim (CardJobs.inFlight)', async () => {
        const cardJobs = statefulCardJobs({ '0001': 'already-running-job' });
        const { poller, broker } = buildPoller([card('0001', 'implementing')], { cardJobs });

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
        expect(cardJobs.record).not.toHaveBeenCalled();
    });

    it('never enqueues a terminal card', async () => {
        for (const stage of ['merged', 'poisoned', 'dropped']) {
            const { poller, broker } = buildPoller([card('0001', stage)]);
            await runOneTick(poller);
            expect(broker.send).not.toHaveBeenCalled();
        }
    });

    it('never enqueues a parked card', async () => {
        const { poller, broker } = buildPoller([card('0001', 'parking-lot')]);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
    });

    it('never enqueues a card flagged for a human', async () => {
        const { poller, broker } = buildPoller([card('0001', 'implementing', { needsHuman: true })]);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
    });

    it('never enqueues a manual-mode stage', async () => {
        const { poller, broker } = buildPoller([card('0001', 'review')]);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
    });

    /**
     * Card 0117's whole point: a manual-stage card at the head of the candidate list must not wedge
     * the tick. `0001` is `wilson card next`'s honest answer for a human — the lowest-id workable
     * card — but the queue can never dispatch a `manual` stage, so the tick must walk past it to
     * `0002` instead of stopping.
     */
    it('skips a manual-stage card at the head of the candidate list and enqueues the dispatchable one behind it', async () => {
        const cards = [card('0001', 'review'), card('0002', 'implementing')];
        const { poller, broker, cardJobs, logger } = buildPoller(cards);

        await runOneTick(poller);

        expect(broker.send).toHaveBeenCalledTimes(1);
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0002', stageName: 'implementing', project: 'poller-test-project' });
        expect(cardJobs.record).toHaveBeenCalledWith('0002', 'job-1');
        expect(logger.info.mock.calls[0]![0]).toContain('0002');
    });

    it('skips a command-stage card the same way as a manual one, and enqueues the dispatchable candidate behind it', async () => {
        const cards = [card('0001', 'triage'), card('0002', 'implementing')];
        const { poller, broker } = buildPoller(cards);

        await runOneTick(poller);

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0002', stageName: 'implementing', project: 'poller-test-project' });
    });

    /**
     * The in-flight check must be asked per candidate, not once against the head of the list: a card
     * someone else already started should not stop the walk, it should just fall through to the next
     * workable candidate.
     */
    it('falls through a candidate that already holds a live claim to the next workable candidate', async () => {
        const cardJobs = statefulCardJobs({ '0001': 'already-running-job' });
        const cards = [card('0001', 'implementing'), card('0002', 'implementing')];
        const { poller, broker } = buildPoller(cards, { cardJobs });

        await runOneTick(poller);

        expect(cardJobs.inFlight).toHaveBeenCalledWith('0001');
        expect(cardJobs.inFlight).toHaveBeenCalledWith('0002');
        expect(broker.send).toHaveBeenCalledTimes(1);
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0002', stageName: 'implementing', project: 'poller-test-project' });
    });

    /**
     * Card 0128, the fix's other half: a candidate `BoardRepository.scopeConflict` says would defer
     * must not be enqueued only to have the job defer immediately — that wastes a cycle and, per the
     * gridlock this card fixes, would also stop the walk right there. The tick must fall through to
     * the next workable candidate instead, exactly as it already does for a manual stage or a live
     * `CardJobs` claim.
     */
    it('skips a candidate that would defer on a scope conflict, enqueuing the next workable candidate instead', async () => {
        const scopeConflict = vi.fn(async (_events: unknown, _project: string, candidate: Card) =>
            candidate.frontmatter.id === '0001' ? { cardId: '0099', overlap: [] } : undefined,
        );
        const cards = [card('0001', 'implementing'), card('0002', 'implementing')];
        const { poller, board, broker, cardJobs, logger } = buildPoller(cards, { scopeConflict });

        await runOneTick(poller);

        expect(scopeConflict).toHaveBeenCalled();
        expect(board.scopeConflict).toBe(scopeConflict);
        expect(broker.send).toHaveBeenCalledTimes(1);
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0002', stageName: 'implementing', project: 'poller-test-project' });
        expect(cardJobs.record).not.toHaveBeenCalledWith('0001', expect.anything());
        expect(logger.info.mock.calls[0]![0]).toContain('0002');
    });

    /**
     * Acceptance criterion, asserted directly: a tick where every candidate conflicts must enqueue
     * nothing, log nothing, and — the gridlock's other symptom — not spin by writing or claiming
     * anything either. `MAX_CANDIDATES_PER_TICK` already bounds the walk itself; this proves a fully
     * conflicted board actually reaches that bound quietly rather than throwing partway through.
     */
    it('a tick where every candidate conflicts enqueues nothing, logs nothing, and does not spin', async () => {
        const scopeConflict = vi.fn(async () => ({ cardId: '0099', overlap: [] }));
        const cards = [card('0001', 'implementing'), card('0002', 'implementing')];
        const { poller, broker, cardJobs, logger } = buildPoller(cards, { scopeConflict });

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
        expect(cardJobs.record).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
    });

    /**
     * Best-effort, per the doc comment on the check: a `scopeConflict` lookup that fails is treated as
     * "no conflict" rather than stopping the walk, exactly like every other best-effort pre-dispatch
     * check in this codebase — a real conflict a failed lookup missed here is still caught correctly
     * by `deferOnScopeConflict` once the job actually runs.
     */
    it('treats a scopeConflict lookup that throws as no conflict, rather than stopping the walk over it', async () => {
        const scopeConflict = vi.fn(async () => {
            throw new Error('board unavailable');
        });
        const { poller, broker } = buildPoller([card('0001', 'implementing')], { scopeConflict });

        await runOneTick(poller);

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing', project: 'poller-test-project' });
    });

    /**
     * A refusal that is not merely "the stage is manual/command" means something is actually wrong —
     * a stage the config doesn't know, here — so the tick must stop exactly where a single-candidate
     * tick always has, rather than routing around it to a dispatchable card behind it.
     */
    it('stops the tick at a candidate refused for a reason other than a non-agent stage, without trying candidates behind it', async () => {
        const cards = [card('0001', 'no-such-stage'), card('0002', 'implementing')];
        const { poller, broker, logger } = buildPoller(cards);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
    });

    it('a tick where every candidate sits in a manual or command stage enqueues nothing, writes nothing and logs nothing', async () => {
        const cards = [card('0001', 'review'), card('0002', 'triage'), card('0003', 'review')];
        const { poller, broker, cardJobs, logger } = buildPoller(cards);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
        expect(cardJobs.record).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
    });

    describe('bounding the walk', () => {
        // 50 manual-stage candidates ('0001'..'0050') ahead of one dispatchable candidate. `card`'s id
        // is a zero-padded 4-digit string, so lexicographic sort matches numeric order up to '9999'.
        const manualCandidates = (count: number, startId: number): Card[] =>
            Array.from({ length: count }, (_, i) => card(String(startId + i).padStart(4, '0'), 'review'));

        it('still reaches a dispatchable candidate sitting at the bound (the 50th candidate)', async () => {
            const cards = [...manualCandidates(49, 1), card('0050', 'implementing')];
            const { poller, broker } = buildPoller(cards);

            await runOneTick(poller);

            expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0050', stageName: 'implementing', project: 'poller-test-project' });
        });

        it('does not reach a dispatchable candidate sitting past the bound (the 51st candidate)', async () => {
            const cards = [...manualCandidates(50, 1), card('0051', 'implementing')];
            const { poller, broker, logger } = buildPoller(cards);

            await runOneTick(poller);

            expect(broker.send).not.toHaveBeenCalled();
            expect(logger.info).not.toHaveBeenCalled();
        });
    });

    it('never enqueues a card whose dependency has not merged', async () => {
        const { poller, broker } = buildPoller([card('0001', 'implementing', { dependsOn: ['0099'] })]);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
    });

    it('takes at most one card per tick — the lowest id, even with several ready candidates', async () => {
        const cards = [card('0003', 'implementing'), card('0001', 'implementing'), card('0002', 'implementing')];
        const { poller, broker } = buildPoller(cards);

        await runOneTick(poller);

        expect(broker.send).toHaveBeenCalledTimes(1);
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing', project: 'poller-test-project' });
    });

    it('a tick that finds nothing dispatchable performs no write and logs nothing at info', async () => {
        const cards = [card('0001', 'merged'), card('0002', 'review'), card('0003', 'implementing', { needsHuman: true })];
        const { poller, broker, cardJobs, logger } = buildPoller(cards);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
        expect(cardJobs.record).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
    });

    it('an empty board performs no write and logs nothing at info', async () => {
        const { poller, broker, logger } = buildPoller([]);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
    });

    it('logs and swallows a failure instead of throwing, so one bad tick does not kill the loop', async () => {
        const config = new StaticBoardConfig('poller-test-project', '/tmp/code', '/tmp/wt', '/tmp/run');
        const boom = new Error('database is on fire');
        const board = { list: vi.fn(async () => Promise.reject(boom)) };
        const logger = fakeLogger();
        const poller = new Poller(
            board as unknown as BoardRepository,
            config,
            stageConfigs,
            fakeBroker() as unknown as JobBroker,
            statefulCardJobs() as unknown as CardJobs,
            logger as unknown as Logger,
            fakeSettingsStore(),
            fakeEvents(),
        );

        await expect(runOneTick(poller)).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(boom);
    });
});

/**
 * Card 0149, task 3: "The poller works every project." Every test above builds a `Poller` without a
 * `ProjectRepository` (the `projects` constructor arg defaults to `undefined`), which — per `tick`'s
 * own doc comment — falls back to ticking the single project `boardConfig.project` already names,
 * reproducing single-project behaviour exactly. These tests are the other half: a `Poller` given a
 * real `ProjectRepository`, ticking every registered project in turn.
 */
describe('Poller tick — multiple registered projects (card 0149)', () => {
    /**
     * One registered project's row. Both projects read the shared `stageConfigs`
     * above: which project's stage config a store answers for is `PostgresStageConfigStore`'s
     * concern, keyed by `BoardConfig.project` the same way the fakes here are, not this block's.
     */
    const projectRow = (name: string): ProjectRow => ({
        name,
        codeRoot: `/tmp/${name}/code`,
        worktreeRoot: `/tmp/${name}/worktrees`,
        runRoot: `/tmp/${name}/run`,
    });

    /**
     * A `CardJobs` fake keyed by `(project, cardId)`, the same pair the real, Postgres-backed
     * `CardJobs` keys its claims by (`wilson.cardJobs`'s `(project, cardId)` conflict target,
     * card.jobs.ts) — unlike `statefulCardJobs` above, which has no notion of project and would make
     * two different projects' identically-id'd cards falsely appear to claim each other.
     */
    const projectScopedCardJobs = (config: ProjectScopedBoardConfig): FakeCardJobs => {
        const claims = new Map<string, string>();
        const key = (project: string, cardId: string) => `${project}::${cardId}`;
        return {
            inFlight: vi.fn(async (cardId: string) => claims.get(key(config.project, cardId))),
            record: vi.fn(async (cardId: string, jobId: string) => {
                claims.set(key(config.project, cardId), jobId);
            }),
            clear: vi.fn(async (cardId: string) => {
                claims.delete(key(config.project, cardId));
            }),
        };
    };

    it('ticks every registered project, enqueuing each against its own project — even when both boards use the same card id', async () => {
        const rows = [projectRow('alpha'), projectRow('beta')];

        const config = new ProjectScopedBoardConfig('alpha');
        // Deliberately left unregistered here: `tick` must register every row itself
        // (`ProjectRepository.list`, then `boardConfig.register` per row) before ticking, exactly as
        // `Poller.tick`'s own doc comment says — a `ProjectScopedBoardConfig` that never saw a
        // project registered throws reading it, so this proves the registration actually happens.
        const projects = { list: vi.fn(async () => rows) } as unknown as ProjectRepository;

        // Same card id, '0001', dispatchable on both boards — the direct check for "two projects'
        // cards sharing an id do not collide on disk" one layer up: each dispatch must still carry
        // its own project, not the other one's.
        const cardsByProject: Record<string, Card[]> = { alpha: [card('0001', 'implementing')], beta: [card('0001', 'implementing')] };
        const board = {
            list: vi.fn(async () => cardsByProject[config.project] ?? []),
            writeWithEvent: vi.fn(async () => 'card-version-1'),
            scopeConflict: noConflict,
        };
        const broker = fakeBroker();
        const cardJobs = projectScopedCardJobs(config);
        const logger = fakeLogger();

        const poller = new Poller(
            board as unknown as BoardRepository,
            config,
            stageConfigs,
            broker as unknown as JobBroker,
            cardJobs as unknown as CardJobs,
            logger as unknown as Logger,
            fakeSettingsStore(),
            fakeEvents(),
            projects,
        );

        await runOneTick(poller);

        expect(projects.list).toHaveBeenCalledTimes(1);
        expect(broker.send).toHaveBeenCalledTimes(2);
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing', project: 'alpha' });
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing', project: 'beta' });
    });

    /**
     * The multi-project reading of "one tick fails, log it, try again next interval" (`tick`'s own
     * doc comment): a project whose own tick throws must not stop the walk over the *other*
     * registered projects in the same tick.
     */
    it('logs and skips a project whose own tick throws, without stopping the walk over the other registered projects', async () => {
        const rows = [projectRow('alpha'), projectRow('beta')];

        const config = new ProjectScopedBoardConfig('alpha');
        const projects = { list: vi.fn(async () => rows) } as unknown as ProjectRepository;

        const boom = new Error('beta board unreachable');
        const board = {
            list: vi.fn(async () => {
                if (config.project === 'beta') throw boom;
                return [card('0001', 'implementing')];
            }),
            writeWithEvent: vi.fn(async () => 'card-version-1'),
            scopeConflict: noConflict,
        };
        const broker = fakeBroker();
        const logger = fakeLogger();

        const poller = new Poller(
            board as unknown as BoardRepository,
            config,
            stageConfigs,
            broker as unknown as JobBroker,
            projectScopedCardJobs(config) as unknown as CardJobs,
            logger as unknown as Logger,
            fakeSettingsStore(),
            fakeEvents(),
            projects,
        );

        await expect(runOneTick(poller)).resolves.toBeUndefined();

        expect(broker.send).toHaveBeenCalledTimes(1);
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing', project: 'alpha' });
        expect(logger.error).toHaveBeenCalledWith(boom);
    });

    /**
     * Distinct from the per-project failure above: this is `ProjectRepository.list()` itself failing,
     * before any project can even be named — `tick`'s outer try/catch, not `tickProject`'s inner one.
     * Nothing can be dispatched at all when the daemon cannot learn which projects exist.
     */
    it('logs and dispatches nothing when listing the registered projects itself fails', async () => {
        const config = new StaticBoardConfig('poller-test-project', '/tmp/code', '/tmp/wt', '/tmp/run');
        const boom = new Error('database is on fire');
        const projects = { list: vi.fn(async () => Promise.reject(boom)) } as unknown as ProjectRepository;
        const board = { list: vi.fn(async () => [card('0001', 'implementing')]) };
        const broker = fakeBroker();
        const logger = fakeLogger();

        const poller = new Poller(
            board as unknown as BoardRepository,
            config,
            stageConfigs,
            broker as unknown as JobBroker,
            statefulCardJobs() as unknown as CardJobs,
            logger as unknown as Logger,
            fakeSettingsStore(),
            fakeEvents(),
            projects,
        );

        await expect(runOneTick(poller)).resolves.toBeUndefined();

        expect(broker.send).not.toHaveBeenCalled();
        expect(board.list).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(boom);
    });
});

describe('Poller tick — the backlog queue (card 0127)', () => {
    /**
     * The whole point of this card: a card already approved and pinned on entry to `backlog`
     * (`BoardWriteService.move`) is queue work now — the poller carries it to `backlog`'s own
     * `onPass` target (read from config, not `implementing`, the more obvious hard-coded guess) and
     * enqueues it there, without a human touching it.
     */
    it('advances a backlog card to its onPass target from config, writing the transition and enqueuing it there', async () => {
        const { poller, board, broker, cardJobs, logger } = buildPoller([card('0001', 'backlog')]);

        await runOneTick(poller);

        expect(board.writeWithEvent).toHaveBeenCalledWith(
            '0001',
            expect.any(String),
            expect.any(Function),
            expect.objectContaining({
                cardId: '0001',
                stage: 'scope-check',
                type: 'transition.written',
                payload: { from: 'backlog', to: 'scope-check', by: 'runner' },
            }),
        );
        // The mutate callback itself lands the card on the onPass target.
        const mutate = board.writeWithEvent.mock.calls[0]![2] as (c: Card) => Card;
        expect(mutate(card('0001', 'backlog')).frontmatter.stage).toBe('scope-check');

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'scope-check', project: 'poller-test-project' });
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-1');
        expect(logger.info.mock.calls[0]![0]).toContain('0001');
    });

    /**
     * Constraint: only `backlog`, never derived from `mode: manual`. `ready` is manual too, with
     * `onPass: merged` — a poller that advanced it the same way `backlog` gets advanced would merge
     * a card to main with nobody having looked. This is the direct assertion the plan calls for.
     */
    it('never advances a card in ready, even though it is also a manual stage', async () => {
        const { poller, board, broker } = buildPoller([card('0001', 'ready')]);

        await runOneTick(poller);

        expect(board.writeWithEvent).not.toHaveBeenCalled();
        expect(broker.send).not.toHaveBeenCalled();
    });

    it('never advances a card in planning either — its onPass is backlog, not something to skip straight past', async () => {
        const { poller, board, broker } = buildPoller([card('0001', 'planning')]);

        await runOneTick(poller);

        expect(board.writeWithEvent).not.toHaveBeenCalled();
        expect(broker.send).not.toHaveBeenCalled();
    });

    it('does not advance a backlog card something already holds a claim on, falling through to the next candidate', async () => {
        const cardJobs = statefulCardJobs({ '0001': 'already-running-job' });
        const cards = [card('0001', 'backlog'), card('0002', 'implementing')];
        const { poller, board, broker } = buildPoller(cards, { cardJobs });

        await runOneTick(poller);

        expect(board.writeWithEvent).not.toHaveBeenCalled();
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0002', stageName: 'implementing', project: 'poller-test-project' });
    });

    /**
     * `nextCard` already excludes flagged and dependency-blocked cards from `candidates` (see
     * next.card.ts) — a backlog card that is either never reaches the poller's walk at all. These
     * prove the acceptance criterion directly, at the level the plan asked for, rather than only
     * trusting that upstream filter.
     */
    it('never advances a backlog card flagged for a human', async () => {
        const cards = [card('0001', 'backlog', { needsHuman: true }), card('0002', 'implementing')];
        const { poller, board, broker } = buildPoller(cards);

        await runOneTick(poller);

        expect(board.writeWithEvent).not.toHaveBeenCalled();
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0002', stageName: 'implementing', project: 'poller-test-project' });
    });

    it('never advances a backlog card blocked on an unmet dependency', async () => {
        const cards = [card('0001', 'backlog', { dependsOn: ['0099'] }), card('0002', 'implementing')];
        const { poller, board, broker } = buildPoller(cards);

        await runOneTick(poller);

        expect(board.writeWithEvent).not.toHaveBeenCalled();
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0002', stageName: 'implementing', project: 'poller-test-project' });
    });

    /**
     * "One candidate per tick, never more" applies to `backlog` exactly as it does to the ordinary
     * enqueue path: advancing `0001` must `return` immediately rather than falling through and also
     * advancing `0002` in the same tick, even though both are free, workable backlog candidates.
     */
    it('advances only the lowest-id backlog candidate per tick, leaving a second free one behind it untouched', async () => {
        const cards = [card('0001', 'backlog'), card('0002', 'backlog')];
        const { poller, board, broker } = buildPoller(cards);

        await runOneTick(poller);

        expect(board.writeWithEvent).toHaveBeenCalledTimes(1);
        expect(board.writeWithEvent).toHaveBeenCalledWith('0001', expect.any(String), expect.any(Function), expect.anything());
        expect(broker.send).toHaveBeenCalledTimes(1);
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'scope-check', project: 'poller-test-project' });
    });

    /**
     * The in-flight fallthrough (`does not advance a backlog card something already holds a claim
     * on`, above) is proven there against a non-backlog card behind it. This proves the same
     * `continue` also reaches a *second* backlog candidate correctly — advancing it, at its own
     * `onPass` target, rather than stopping the walk once the first backlog card is skipped.
     */
    it('falls through an in-flight backlog card to a second, free backlog candidate behind it', async () => {
        const cardJobs = statefulCardJobs({ '0001': 'already-running-job' });
        const cards = [card('0001', 'backlog'), card('0002', 'backlog')];
        const { poller, board, broker, cardJobs: jobs } = buildPoller(cards, { cardJobs });

        await runOneTick(poller);

        expect(board.writeWithEvent).toHaveBeenCalledTimes(1);
        expect(board.writeWithEvent).toHaveBeenCalledWith('0002', expect.any(String), expect.any(Function), expect.anything());
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0002', stageName: 'scope-check', project: 'poller-test-project' });
        expect(jobs.record).toHaveBeenCalledWith('0002', 'job-1');
    });
});

/**
 * Card 0264. `tickProject` refuses to enqueue anything at all, for the whole project, once
 * `EventLog.outputTokensSince` says today's spend has reached `DAILY_OUTPUT_TOKEN_CEILING` — checked
 * once per tick, ahead of `nextCard`/`whyNotDispatchable`, so it must short-circuit before the board is
 * even listed. `buildPoller`'s own `fakeSettingsStore` already answers every definition's coded
 * default (0, no ceiling) and `fakeEvents` is a bare `{}` that would throw if `outputTokensSince` were
 * ever called on it — every test above this block already proves AC1 (a ceiling of 0 never queries
 * usage) by surviving that double at all. These are the ceiling's own tests, with a real one set.
 */
describe('Poller tick — the daily output token ceiling (card 0264)', () => {
    const settingsWithCeiling = (ceiling: number): SettingsStore =>
        ({
            get: vi.fn(async (definition: { key: string; defaultValue: unknown }) =>
                definition.key === DAILY_OUTPUT_TOKEN_CEILING.key ? ceiling : definition.defaultValue,
            ),
            set: vi.fn(async () => undefined),
        }) as unknown as SettingsStore;

    const eventsWithSpend = (spent: number) => ({ outputTokensSince: vi.fn(async () => spent) }) as unknown as EventLog;

    // AC2: spend below the ceiling enqueues exactly as it does today.
    it('AC2: spend below the ceiling enqueues exactly as it does today, asking outputTokensSince over a window starting at local midnight (AC6)', async () => {
        const events = eventsWithSpend(500);
        const { poller, broker, logger } = buildPoller([card('0001', 'implementing')], { settings: settingsWithCeiling(1000), events });

        await runOneTick(poller);

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing', project: 'poller-test-project' });
        expect(logger.error).not.toHaveBeenCalled();

        expect(events.outputTokensSince).toHaveBeenCalledTimes(1);
        const [project, since] = (events.outputTokensSince as ReturnType<typeof vi.fn>).mock.calls[0] as [string, DateTime];
        expect(project).toBe('poller-test-project');
        // AC6: the instant passed is its own start-of-day, not merely "some time in the past".
        expect(since.startOf('day').toMillis()).toBe(since.toMillis());
    });

    // AC3 + AC7: spend at or over the ceiling enqueues nothing for that project, logs exactly once,
    // and never even reaches the board (proving the check runs before dispatch, not during one) — while
    // a second, independently-ticked project under its own ceiling still enqueues normally.
    it('AC3/AC7: spend at or over the ceiling enqueues nothing and logs once, without listing the board; a second project under its own ceiling still enqueues', async () => {
        const overEvents = eventsWithSpend(1000);
        const overBoard = {
            list: vi.fn(async () => [card('0001', 'implementing')]),
            writeWithEvent: vi.fn(async () => 'v1'),
            scopeConflict: noConflict,
        };
        const overConfig = new StaticBoardConfig('over-budget-project', '/tmp/code', '/tmp/wt', '/tmp/run');
        const overBroker = fakeBroker();
        const overLogger = fakeLogger();
        const overPoller = new Poller(
            overBoard as unknown as BoardRepository,
            overConfig,
            stageConfigs,
            overBroker as unknown as JobBroker,
            statefulCardJobs() as unknown as CardJobs,
            overLogger as unknown as Logger,
            settingsWithCeiling(1000),
            overEvents,
        );

        await runOneTick(overPoller);

        expect(overBoard.list).not.toHaveBeenCalled();
        expect(overBroker.send).not.toHaveBeenCalled();
        expect(overLogger.error).toHaveBeenCalledTimes(1);
        expect(overLogger.error.mock.calls[0]![0]).toContain('over-budget-project');
        expect(overLogger.error.mock.calls[0]![0]).toContain('1000');

        // A second project, ticked independently under its own ceiling, is untouched by the first's.
        const { poller: underPoller, broker: underBroker } = buildPoller([card('0002', 'implementing')], {
            settings: settingsWithCeiling(1000),
            events: eventsWithSpend(10),
        });

        await runOneTick(underPoller);

        expect(underBroker.send).toHaveBeenCalledWith('card.stage', { cardId: '0002', stageName: 'implementing', project: 'poller-test-project' });
    });
});

describe('Poller start/stop', () => {
    afterEach(async () => {
        // Belt and braces: abort anything a test left running so it cannot bleed into the next one.
        for (const entry of [...pending]) entry.resolve();
    });

    it('start() is idempotent: a second call while already running does not start a second loop', async () => {
        const { poller } = buildPoller([]);

        poller.start();
        poller.start();

        // Exactly one loop means exactly one outstanding interval wait, not two. Awaited rather than
        // asserted immediately: card 0115 makes `loop()` read `POLLER_INTERVAL_MS` from the
        // `SettingsStore` fake before its first `delay()` call, which is now at least one microtask
        // tick away rather than synchronous.
        await vi.waitFor(() => expect(pending).toHaveLength(1));

        await poller.stop();
    });

    it('stop() is safe to call when the poller was never started', async () => {
        const { poller } = buildPoller([]);

        await expect(poller.stop()).resolves.toBeUndefined();
    });

    it('ticks through the real public start()/stop() surface once the interval elapses, using POLLER_INTERVAL_MS', async () => {
        const { poller, broker, cardJobs } = buildPoller([card('0001', 'implementing')]);

        poller.start();
        // Awaited rather than asserted immediately, for the same reason as the idempotency test
        // above: `loop()` awaits the settings read before its first `delay()` call.
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(
                POLLER_INTERVAL_MS_DEFAULT,
                undefined,
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            ),
        );
        releaseTick();

        await vi.waitFor(() => expect(broker.send).toHaveBeenCalledTimes(1));
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-1');

        await poller.stop();
    });

    /**
     * The property `jobs.module.ts`'s shutdown ordering depends on: once `stop()` resolves, nothing
     * is still mid-enqueue behind it. Proven here by holding a tick open on a `board.list()` that
     * will not resolve until the test says so, and showing `stop()`'s promise cannot have completed
     * before that — not by timing, but because it is causally blocked on the same promise chain.
     */
    it('stop() waits out a tick already in flight rather than abandoning it mid-enqueue', async () => {
        let releaseList: (() => void) | undefined;
        const cards = [card('0001', 'implementing')];
        const board = {
            list: vi.fn(
                () =>
                    new Promise<Card[]>(resolve => {
                        releaseList = () => resolve(cards);
                    }),
            ),
        };
        const cardJobs = statefulCardJobs();
        const broker = fakeBroker();
        const config = new StaticBoardConfig('poller-test-project', '/tmp/code', '/tmp/wt', '/tmp/run');
        const poller = new Poller(
            board as unknown as BoardRepository,
            config,
            stageConfigs,
            broker as unknown as JobBroker,
            cardJobs as unknown as CardJobs,
            fakeLogger() as unknown as Logger,
            fakeSettingsStore(),
            fakeEvents(),
        );

        poller.start();
        // The interval read (card 0115) puts at least one microtask tick between start() and the
        // delay() call `releaseTick()` needs to find waiting in `pending`.
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        releaseTick();
        await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(1));

        const stopPromise = poller.stop();
        // The in-flight tick is still blocked inside board.list(), so it cannot have reached the
        // broker yet — this is a causal guarantee, not a timing assumption.
        expect(broker.send).not.toHaveBeenCalled();

        releaseList!();
        await stopPromise;

        expect(broker.send).toHaveBeenCalledTimes(1);
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-1');
    });

    /**
     * Constraint: "The poller reads its interval per tick, not once. Otherwise a change needs a
     * restart, which is the defect 0106 existed to fix." `loop()`'s comment says the same, but
     * nothing yet proves it against the real `start()`/`stop()` surface: a settings row changing
     * value between two ticks — with no `stop()`/`start()` cycle in between — must change the very
     * next wait, not merely the one after a restart.
     */
    it('applies a changed POLLER_INTERVAL_MS to the next wait without a restart', async () => {
        const settings = intervalReadSequence({ value: POLLER_INTERVAL_MS_DEFAULT }, { value: 5_000 });
        const { poller } = buildPoller([], { settings });

        poller.start();
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(
                POLLER_INTERVAL_MS_DEFAULT,
                undefined,
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            ),
        );

        // Let the first wait elapse and the tick after it run — loop() reads the setting again
        // before its *next* delay() call, with no stop()/start() anywhere in between.
        releaseTick();
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(5_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) })),
        );

        await poller.stop();
    });

    /**
     * Card 0257: on 2026-09-19 a database outage took the interval read down with it — it sat
     * outside any `try`, so a rejected `settings.get` became an unhandled rejection that killed the
     * daemon. These drive the real `start()`/`stop()` surface (not the private `loop()` directly) so
     * a regression back to the old, unprotected read shows up exactly as it did in production: the
     * loop never reaches its first `delay()` call at all, and every `vi.waitFor` below times out.
     */
    describe('the interval read survives a database outage (card 0257)', () => {
        it('AC1: a settings store whose get() always rejects logs each failure, waits the default interval, and keeps calling tick', async () => {
            const boom = new Error('ECONNREFUSED');
            const settings = failingIntervalSettings(boom);
            const { poller, board, logger } = buildPoller([card('0001', 'implementing')], { settings });

            poller.start();
            await vi.waitFor(() =>
                expect(delayMock).toHaveBeenCalledWith(
                    POLLER_INTERVAL_MS_DEFAULT,
                    undefined,
                    expect.objectContaining({ signal: expect.any(AbortSignal) }),
                ),
            );
            expect(logger.error).toHaveBeenCalledWith(boom);

            releaseTick();
            await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(1));

            // A second failing iteration behaves exactly like the first — logs again, waits the
            // default again — rather than busy-looping or giving up after a single retry.
            await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(2));
            expect(delayMock).toHaveBeenLastCalledWith(
                POLLER_INTERVAL_MS_DEFAULT,
                undefined,
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
            expect(logger.error).toHaveBeenCalledTimes(2);

            releaseTick();
            await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(2));

            await poller.stop();
        });

        it('AC2: a read that fails after a successful 5000ms read falls back to that last known-good value, not the default', async () => {
            const boom = new Error('ECONNREFUSED');
            const settings = intervalReadSequence({ value: 5_000 }, { error: boom });
            const { poller, logger } = buildPoller([], { settings });

            poller.start();
            await vi.waitFor(() =>
                expect(delayMock).toHaveBeenCalledWith(5_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) })),
            );

            // The wait elapses, the tick after it runs, and loop() reads the setting again — this
            // time it rejects, and the fallback must be 5000 (the last known-good value), not
            // POLLER_INTERVAL_MS_DEFAULT.
            releaseTick();
            await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(2));
            expect(delayMock).toHaveBeenLastCalledWith(5_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));
            expect(logger.error).toHaveBeenCalledWith(boom);

            await poller.stop();
        });

        it('AC3: a read that fails and then recovers uses the freshly read value on the very next iteration', async () => {
            const boom = new Error('ECONNREFUSED');
            const settings = intervalReadSequence({ error: boom }, { value: 7_000 });
            const { poller } = buildPoller([], { settings });

            poller.start();
            // Never having read a good value yet, the first failure falls back to the default.
            await vi.waitFor(() =>
                expect(delayMock).toHaveBeenCalledWith(
                    POLLER_INTERVAL_MS_DEFAULT,
                    undefined,
                    expect.objectContaining({ signal: expect.any(AbortSignal) }),
                ),
            );

            releaseTick();
            await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(2));
            expect(delayMock).toHaveBeenLastCalledWith(7_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));

            await poller.stop();
        });

        it('AC4: aborting mid-wait during a failing settings read still returns from stop() immediately, without waiting out a retry cycle', async () => {
            const settings = {
                get: vi.fn(async () => {
                    throw new Error('ECONNREFUSED');
                }),
                set: vi.fn(async () => undefined),
            } as unknown as SettingsStore;
            const { poller, board } = buildPoller([], { settings });

            poller.start();
            await vi.waitFor(() => expect(pending).toHaveLength(1));

            // If stop() had to wait out a whole retry cycle (another failing read plus another
            // delay) instead of returning as soon as the in-flight wait aborts, this would hang past
            // the test's own timeout rather than resolving.
            await expect(poller.stop()).resolves.toBeUndefined();

            expect(board.list).not.toHaveBeenCalled();
        });

        it('AC5: repeated rejected settings reads across several iterations never reject the loop; stop() still resolves cleanly', async () => {
            const settings = failingIntervalSettings(new Error('ECONNREFUSED'));
            const { poller, board } = buildPoller([], { settings });

            poller.start();
            await vi.waitFor(() => expect(pending).toHaveLength(1));
            releaseTick();
            await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(1));
            releaseTick();
            await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(2));
            releaseTick();
            await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(3));

            // Were a rejected settings read able to escape loop() as an unhandled rejection, it would
            // have already surfaced by now — either as a rejection from stop() below, or as a process
            // warning this run captures.
            await expect(poller.stop()).resolves.toBeUndefined();
        });
    });

    it('a subsequent start() after stop() begins ticking again rather than staying blocked forever', async () => {
        const { poller, board } = buildPoller([card('0001', 'implementing')]);

        poller.start();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        releaseTick();
        await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(1));
        await poller.stop();

        poller.start();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        releaseTick();
        await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(2));

        await poller.stop();
    });
});
