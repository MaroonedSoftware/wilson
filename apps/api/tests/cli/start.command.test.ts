import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardConfig, BoardRepository, CardJobs, JobBroker, PgBoss, type Card } from '@wilson/api/cli-bootstrap';

// `start.command.ts` wraps its handler in johnny5's `requireContainer`, exactly like the other CLI
// commands under test here — see `move.command.test.ts` for why the stub below is enough to make the
// wrapped handler directly callable.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

const { default: command } = await import('../../../../packages/cli/src/commands/card/start.command.js');

type Handler = (opts: unknown, ctx: unknown, args: unknown[]) => Promise<number | void>;
const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

/** A card whose `Files in scope` section holds the given patterns, one bullet per line. */
const card = (id: string, filesInScope: string[], overrides: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'implementing', dependsOn: [], retries: {}, ...overrides },
    sections: { 'Files in scope': filesInScope.map(f => `- ${f}`).join('\n') },
    body: '',
});

describe('wilson card start — warns on scope overlap with an in-flight card', () => {
    let boardRoot: string;
    let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let pgBoss: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
        // A minimal, real stages.yaml — `whyNotDispatchable`/`loadStages` read straight off disk, not
        // through the container, the same as every other `card start`/`card run` test.
        const base = await mkdtemp(join(tmpdir(), 'start-command-'));
        boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await writeFile(
            join(boardRoot, 'config', 'stages.yaml'),
            [
                'stages:',
                '  - name: implementing',
                '    mode: agent',
                '    model: claude-test-model',
                '    instructions: do it',
                '    onPass: testing',
                '    onFail: implementing',
                '  - name: testing',
                '    mode: agent',
                '    model: claude-test-model',
                '    instructions: test it',
                '    onPass: merged',
                '    onFail: implementing',
                '',
            ].join('\n'),
            'utf8',
        );

        logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        broker = { send: vi.fn().mockResolvedValue('job-999') };
        pgBoss = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    });

    /**
     * Builds a fake container: `board` answers `read`/`list`, `inFlightIds` says which of those
     * cards' ids currently hold a live claim (everything else answers `undefined`, i.e. not in
     * flight).
     */
    const buildCtx = (board: { read: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> }, inFlightIds: Record<string, string>) => {
        const cardJobs = {
            inFlight: vi.fn(async (cardId: string) => inFlightIds[cardId]),
            record: vi.fn(async () => {}),
        };
        const container = {
            get: (token: unknown) => {
                if (token === BoardConfig) return { boardRoot };
                if (token === BoardRepository) return board;
                if (token === JobBroker) return broker;
                if (token === PgBoss) return pgBoss;
                if (token === CardJobs) return cardJobs;
                throw new Error(`buildCtx: unexpected token ${String(token)}`);
            },
        };
        return { ctx: { container, logger }, cardJobs };
    };

    // The motivating incident, reproduced: 0066 named the two files directly, 0051's scope covered
    // them with a directory glob. 0051 is genuinely in flight (a live job claims it). Starting 0066
    // must warn, naming 0051 and both shared files — and must still enqueue, since overlapping globs
    // are sometimes fine and this check has no way to tell the cases apart.
    it('warns naming the in-flight card and the overlapping files, and still enqueues (the 0066/0051 case)', async () => {
        const card0066 = card('0066', ['apps/api/src/modules/jobs/jobs.module.ts', 'apps/api/src/modules/jobs/card.stage.job.ts']);
        const card0051 = card('0051', ['apps/api/src/modules/jobs/**']);
        const board = {
            read: vi.fn().mockResolvedValue(card0066),
            list: vi.fn().mockResolvedValue([card0066, card0051]),
        };
        const { ctx, cardJobs } = buildCtx(board, { '0051': 'job-051' });

        const result = await run(ctx, '0066');

        expect(result).toBe(0);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        const [warning] = logger.warn.mock.calls[0] as [string];
        expect(warning).toContain('0051');
        expect(warning).toContain('apps/api/src/modules/jobs/jobs.module.ts');
        expect(warning).toContain('apps/api/src/modules/jobs/card.stage.job.ts');

        // Warn, don't refuse: the card still gets enqueued and claimed.
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0066', stageName: 'implementing' });
        expect(cardJobs.record).toHaveBeenCalledWith('0066', 'job-999');
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not warn when scopes are disjoint, even though the other card is in flight', async () => {
        const starting = card('0002', ['apps/web/src/a.ts']);
        const other = card('0001', ['apps/api/src/b.ts']);
        const board = { read: vi.fn().mockResolvedValue(starting), list: vi.fn().mockResolvedValue([starting, other]) };
        const { ctx } = buildCtx(board, { '0001': 'job-001' });

        const result = await run(ctx, '0002');

        expect(result).toBe(0);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(broker.send).toHaveBeenCalled();
    });

    it('does not warn when scopes overlap but the other card holds no live claim', async () => {
        const starting = card('0002', ['apps/api/src/modules/jobs/jobs.module.ts']);
        const other = card('0001', ['apps/api/src/modules/jobs/**']);
        const board = { read: vi.fn().mockResolvedValue(starting), list: vi.fn().mockResolvedValue([starting, other]) };
        // 0001 is on the board but not in flight: `inFlight` resolves undefined for it.
        const { ctx } = buildCtx(board, {});

        const result = await run(ctx, '0002');

        expect(result).toBe(0);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(broker.send).toHaveBeenCalled();
    });

    it('never compares the starting card against itself', async () => {
        const starting = card('0002', ['apps/api/src/a.ts']);
        const board = { read: vi.fn().mockResolvedValue(starting), list: vi.fn().mockResolvedValue([starting]) };

        // The handler's own "already carrying" refusal calls `inFlight(cardId)` once, before the
        // collision loop even starts, and that call must see no live claim or the command exits 1
        // before reaching the loop at all. Only a *second* call for the same id — which can only
        // happen if the loop failed to skip comparing the card against itself — would see a claim.
        // If the explicit `other.frontmatter.id === cardId` skip in start.command.ts were removed,
        // this second call fires, scopeOverlap(scope, scope) trivially overlaps (identical patterns),
        // and the command would warn about 0002 colliding with itself.
        let calls = 0;
        const cardJobs = {
            inFlight: vi.fn(async (id: string) => {
                calls += 1;
                return calls === 1 ? undefined : id === '0002' ? 'job-self-in-loop' : undefined;
            }),
            record: vi.fn(async () => {}),
        };
        const container = {
            get: (token: unknown) => {
                if (token === BoardConfig) return { boardRoot };
                if (token === BoardRepository) return board;
                if (token === JobBroker) return broker;
                if (token === PgBoss) return pgBoss;
                if (token === CardJobs) return cardJobs;
                throw new Error(`buildCtx: unexpected token ${String(token)}`);
            },
        };

        const result = await run({ container, logger }, '0002');

        expect(result).toBe(0);
        expect(cardJobs.inFlight).toHaveBeenCalledTimes(1);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('warns once per colliding card even when several of its patterns overlap the starting scope', async () => {
        const starting = card('0002', ['apps/api/src/modules/jobs/jobs.module.ts', 'apps/api/src/modules/jobs/card.stage.job.ts']);
        const other = card('0001', ['apps/api/src/modules/jobs/jobs.module.ts', 'apps/api/src/modules/jobs/card.stage.job.ts']);
        const board = { read: vi.fn().mockResolvedValue(starting), list: vi.fn().mockResolvedValue([starting, other]) };
        const { ctx } = buildCtx(board, { '0001': 'job-001' });

        const result = await run(ctx, '0002');

        expect(result).toBe(0);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });
});
