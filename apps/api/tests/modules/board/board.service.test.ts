import { describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import type { Logger } from '@maroonedsoftware/logger';
import { BoardService } from '#modules/board/board.service.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { BoardRepository, CardVersionSummary } from '#modules/board/board.repository.js';
import type { EventLog, CardEventRow } from '#modules/events/event.log.js';
import type { Card } from '#modules/board/card.js';

const config = new StaticBoardConfig('proj', '/tmp/code', '/tmp/wt', '/tmp/run');

// Card 0160: `BoardService` now resolves `CardSummary.resolvedBranch` through
// `WorktreeManager.resolveBranch` — the one place that derivation lives — rather than
// re-implementing it here. `resolveBranch`/`branchName` are pure (no git, no `this.config`,
// no `this.logger`), so a real instance is safe to construct with a config nothing here reads
// and a logger nothing here calls.
const worktrees = new WorktreeManager(config, {} as unknown as Logger);

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}, sections: Card['sections'] = {}, body = 'body text'): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'implementing', dependsOn: [], retries: {}, ...overrides },
    sections,
    body,
});

// Card 0178: `list`/`getById` now read each card's event tail to derive `stageEnteredAt`. Most
// tests below don't care about that field, so this fake answers every `tail` call with no events —
// the same "history cannot answer the question" case that leaves `stageEnteredAt` absent.
const noHistory = { tail: async () => [] } as unknown as EventLog;

/**
 * `BoardService` is a thin translation layer over `BoardRepository` and `EventLog`, so every test
 * here hands it hand-rolled fakes for those two collaborators — the same idiom
 * `postgres.board.repository.test.ts` uses for the parts of `EventLog` it doesn't need. The board
 * repository itself already has its own Postgres-backed tests; nothing here re-tests persistence.
 */
describe('BoardService', () => {
    describe('activity', () => {
        it('reads the configured project, clamps the limit and turns a missing title into null', async () => {
            const recent = vi.fn(async () => [
                { id: '7', cardId: '0001', stage: 'review', type: 'stage.passed', payload: {}, createdAt: DateTime.utc() },
            ]);
            const service = new BoardService({} as unknown as BoardRepository, { recent } as unknown as EventLog, config, worktrees);

            const [event] = await service.activity({ limit: 1_000_000, before: 9 });

            expect(recent).toHaveBeenCalledWith('proj', expect.any(Number), 9);
            expect((recent.mock.calls[0] as unknown[])[1]).toBeLessThan(1_000_000);
            expect(event).toMatchObject({ id: '7', cardId: '0001', cardTitle: null, type: 'stage.passed' });
        });
    });

    describe('list', () => {
        it('maps board cards into summaries, leaving body and sections behind', async () => {
            const cards = [card('0001', { title: 'Ship it', stage: 'review', branch: 'card/0001', dependsOn: ['0000'] }, { Goal: 'x' }, 'the body')];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const summaries = await service.list();

            expect(summaries).toEqual([
                {
                    id: '0001',
                    title: 'Ship it',
                    stage: 'review',
                    branch: 'card/0001',
                    resolvedBranch: 'card/0001',
                    dependsOn: ['0000'],
                    needsHuman: false,
                    needsHumanReason: undefined,
                },
            ]);
            expect(summaries[0]).not.toHaveProperty('body');
            expect(summaries[0]).not.toHaveProperty('sections');
        });

        it('defaults needsHuman to false on the wire when the frontmatter omits it, so the web never sees an absent flag', async () => {
            const cards = [card('0001', { needsHuman: undefined })];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const [summary] = await service.list();

            expect(summary!.needsHuman).toBe(false);
            expect(summary!.needsHumanReason).toBeUndefined();
        });

        it('carries needsHuman and its reason through to the summary when the frontmatter sets them', async () => {
            const cards = [card('0001', { needsHuman: true, needsHumanReason: 'waiting on legal sign-off' })];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const [summary] = await service.list();

            expect(summary!.needsHuman).toBe(true);
            expect(summary!.needsHumanReason).toBe('waiting on legal sign-off');
        });

        it('leaves branch undefined for a card that has none, rather than sending null', async () => {
            const cards = [card('0001', { branch: undefined })];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const [summary] = await service.list();

            expect(summary!.branch).toBeUndefined();
        });

        // Card 0160: most cards never record a `branch` (card 0095) — `resolvedBranch` still has to
        // answer with `WorktreeManager.branchName`'s derivation from the title in that case, not
        // come back undefined the way `branch` itself does above.
        it('derives resolvedBranch from the title for a card that never recorded a branch', async () => {
            const cards = [card('0002', { title: 'Fix the thing', branch: undefined })];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const [summary] = await service.list();

            expect(summary!.branch).toBeUndefined();
            expect(summary!.resolvedBranch).toBe(worktrees.branchName('0002', 'Fix the thing'));
        });

        // Card 0091: `position` orders the parking lot on the wire now, instead of being left off
        // CardSummary entirely.
        it("carries a card's position through to the summary when it has one", async () => {
            const cards = [card('0001', { stage: 'parking-lot', position: 1500 })];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const [summary] = await service.list();

            expect(summary!.position).toBe(1500);
        });

        it('leaves position undefined for a card nothing has ever dragged, rather than sending null', async () => {
            const cards = [card('0001', { stage: 'parking-lot', position: undefined })];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const [summary] = await service.list();

            expect(summary!.position).toBeUndefined();
        });

        // Card 0178: a moved card's summary reports when it entered its current stage — the same
        // `transition.written` moment `wilson card show` already surfaces for a single card.
        it("reports stageEnteredAt as the card's most recent transition", async () => {
            const cards = [card('0001', { stage: 'review' })];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const enteredReview = DateTime.fromISO('2024-01-02T00:00:00.000Z');
            const eventLog = {
                tail: async () => [
                    { id: '1', stage: 'implementing', type: 'stage.dispatched', payload: {}, createdAt: DateTime.fromISO('2024-01-01T00:00:00.000Z') },
                    { id: '2', stage: 'review', type: 'transition.written', payload: {}, createdAt: enteredReview },
                ],
            } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            const [summary] = await service.list();

            expect(summary!.stageEnteredAt).toEqual(enteredReview);
        });

        // Card 0178: a card whose fetched event history has no events at all has no answer to "when
        // did this enter its stage" — the field stays absent rather than guessing.
        it('omits stageEnteredAt for a card with no usable event history', async () => {
            const cards = [card('0001')];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const [summary] = await service.list();

            expect(summary!.stageEnteredAt).toBeUndefined();
        });

        it("reads each card's own event tail for this board's project, not some other card's or project's", async () => {
            const cards = [card('0001')];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            let seenArgs: [string, string] | undefined;
            const eventLog = {
                tail: async (project: string, id: string) => {
                    seenArgs = [project, id];
                    return [];
                },
            } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            await service.list();

            expect(seenArgs).toEqual(['proj', '0001']);
        });

        // Card 0178 review: a card mid-stage can rack up more events than the lookback window (an
        // agent's own tool calls, mostly) without ever transitioning within it. A full window with
        // no `transition.written` in it does not mean the card never transitioned — it means the
        // transition, if any, fell outside the window this fetch happened to cover. Falling back to
        // the window's earliest event in that case would report a wrong, too-recent timestamp as
        // fact; this proves `stageEnteredAt` comes back absent instead.
        it('omits stageEnteredAt, rather than guessing, when the lookback window is full but holds no transition', async () => {
            const cards = [card('0001', { stage: 'implementing' })];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const fullWindowNoTransition = Array.from({ length: 20 }, (_, i) => ({
                id: String(i),
                stage: 'implementing',
                type: 'tool.executed',
                payload: {},
                createdAt: DateTime.fromISO('2024-01-01T00:00:00.000Z').plus({ minutes: i }),
            }));
            const eventLog = { tail: async () => fullWindowNoTransition } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            const [summary] = await service.list();

            expect(summary!.stageEnteredAt).toBeUndefined();
        });

        // Card 0178 review: the same full-window case, but the transition is present in the
        // window — the fix must not turn a genuinely answerable case into a guess either.
        it('still reports stageEnteredAt when the lookback window is full and the transition is within it', async () => {
            const cards = [card('0001', { stage: 'review' })];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const enteredReview = DateTime.fromISO('2024-01-01T00:10:00.000Z');
            const fullWindow = Array.from({ length: 20 }, (_, i) => ({
                id: String(i),
                stage: i < 10 ? 'implementing' : 'review',
                type: i === 10 ? 'transition.written' : 'tool.executed',
                payload: {},
                createdAt: i === 10 ? enteredReview : DateTime.fromISO('2024-01-01T00:00:00.000Z').plus({ minutes: i }),
            }));
            const eventLog = { tail: async () => fullWindow } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            const [summary] = await service.list();

            expect(summary!.stageEnteredAt).toEqual(enteredReview);
        });

        // Card 0178: only a handful of a card's most recent events are fetched to answer
        // `stageEnteredAt` — the same bounded lookback `wilson card show` already uses, not the
        // card's entire history.
        it('bounds the event tail it reads to a small lookback window rather than the full history', async () => {
            const cards = [card('0001')];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            let seenLimit: number | undefined;
            const eventLog = {
                tail: async (_project: string, _id: string, limit: number) => {
                    seenLimit = limit;
                    return [];
                },
            } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            await service.list();

            expect(seenLimit).toBe(20);
        });
    });

    describe('getById', () => {
        it('includes the body and kebab-cases every section heading', async () => {
            const found = card('0001', { title: 'Ship it', stage: 'review' }, { Goal: 'Do it.', 'Files in scope': '- src/a.ts' }, 'full body');
            const boardRepository = {
                list: async () => [],
                read: async (id: string) => {
                    expect(id).toBe('0001');
                    return found;
                },
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const detail = await service.getById('0001');

            expect(detail.body).toBe('full body');
            expect(detail.sections).toEqual({ goal: 'Do it.', 'files-in-scope': '- src/a.ts' });
        });

        // Card 0160: `getById` stitches `resolvedBranch` on just like `list` does, whether or not the
        // card ever recorded a `branch` of its own.
        it('resolves the branch on a single card the same way list does', async () => {
            const recorded = card('0001', { branch: 'card/0001-custom' });
            const unrecorded = card('0002', { title: 'Fix the thing', branch: undefined });
            const boardRepository = {
                list: async () => [],
                read: async (id: string) => (id === '0001' ? recorded : unrecorded),
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            expect((await service.getById('0001')).resolvedBranch).toBe('card/0001-custom');
            expect((await service.getById('0002')).resolvedBranch).toBe(worktrees.branchName('0002', 'Fix the thing'));
        });

        // Card 0178: `getById` stitches `stageEnteredAt` on just like `list` does.
        it('reports stageEnteredAt as the moment the card last transitioned', async () => {
            const found = card('0001', { stage: 'review' });
            const boardRepository = { list: async () => [], read: async () => found } as unknown as BoardRepository;
            const enteredReview = DateTime.fromISO('2024-01-02T00:00:00.000Z');
            const eventLog = {
                tail: async () => [{ id: '1', stage: 'review', type: 'transition.written', payload: {}, createdAt: enteredReview }],
            } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            const detail = await service.getById('0001');

            expect(detail.stageEnteredAt).toEqual(enteredReview);
        });

        it('omits stageEnteredAt for a card with no usable event history', async () => {
            const found = card('0001');
            const boardRepository = { list: async () => [], read: async () => found } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const detail = await service.getById('0001');

            expect(detail.stageEnteredAt).toBeUndefined();
        });

        it('lists the cards split out of this one, lowest id first, and carries splitFrom on a piece', async () => {
            const origin = card('0001');
            const pieceA = card('0002', { title: 'Piece A', stage: 'merged', splitFrom: '0001' });
            const pieceB = card('0003', { title: 'Piece B', stage: 'planning', splitFrom: '0001' });
            const unrelated = card('0004', { splitFrom: '0099' });
            const boardRepository = {
                list: async () => [unrelated, pieceB, origin, pieceA],
                read: async (id: string) => (id === '0001' ? origin : pieceA),
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            const detail = await service.getById('0001');

            expect(detail.pieces).toEqual([
                { id: '0002', title: 'Piece A', stage: 'merged' },
                { id: '0003', title: 'Piece B', stage: 'planning' },
            ]);
            expect(detail.splitFrom).toBeUndefined();

            const piece = await service.getById('0002');
            expect(piece.splitFrom).toBe('0001');
            expect(piece.pieces).toEqual([]);
        });

        it('carries splitFrom on a summary from list', async () => {
            const boardRepository = { list: async () => [card('0002', { splitFrom: '0001' })] } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            expect((await service.list())[0]!.splitFrom).toBe('0001');
        });

        it('translates a missing card into a 404 rather than letting it become a 500', async () => {
            const boardRepository = {
                list: async () => [],
                read: async () => {
                    throw new CardNotFoundError('card 0001 does not exist');
                },
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            await expect(service.getById('missing')).rejects.toMatchObject({ statusCode: 404 });
        });

        it('leaves any other error alone, rather than folding it into a 404', async () => {
            const boom = new Error('database is unreachable');
            const boardRepository = {
                list: async () => [],
                read: async () => {
                    throw boom;
                },
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            await expect(service.getById('0001')).rejects.toBe(boom);
        });
    });

    describe('events', () => {
        it('defaults the limit to 50 when the caller omits it', async () => {
            let seenLimit: number | undefined;
            const eventLog = {
                tail: async (_project: string, _id: string, limit: number) => {
                    seenLimit = limit;
                    return [];
                },
            } as unknown as EventLog;
            const service = new BoardService({} as unknown as BoardRepository, eventLog, config, worktrees);

            await service.events('0001', {});

            expect(seenLimit).toBe(50);
        });

        it('caps the limit at 200 even when the caller asks for far more', async () => {
            let seenLimit: number | undefined;
            const eventLog = {
                tail: async (_project: string, _id: string, limit: number) => {
                    seenLimit = limit;
                    return [];
                },
            } as unknown as EventLog;
            const service = new BoardService({} as unknown as BoardRepository, eventLog, config, worktrees);

            await service.events('0001', { limit: 10000 });

            expect(seenLimit).toBe(200);
        });

        it("reads the tail of this board's project and this card, not some other one", async () => {
            let seenArgs: [string, string] | undefined;
            const eventLog = {
                tail: async (project: string, id: string) => {
                    seenArgs = [project, id];
                    return [];
                },
            } as unknown as EventLog;
            const service = new BoardService({} as unknown as BoardRepository, eventLog, config, worktrees);

            await service.events('0007', {});

            expect(seenArgs).toEqual(['proj', '0007']);
        });

        it('maps each event row into the wire shape unchanged', async () => {
            const createdAt = DateTime.fromISO('2024-01-01T00:00:00.000Z');
            const rows: CardEventRow[] = [{ id: '1', type: 'stage.passed', stage: 'implementing', payload: { foo: 'bar' }, createdAt }];
            const eventLog = { tail: async () => rows } as unknown as EventLog;
            const service = new BoardService({} as unknown as BoardRepository, eventLog, config, worktrees);

            const events = await service.events('0001', {});

            expect(events).toEqual([{ id: '1', type: 'stage.passed', stage: 'implementing', payload: { foo: 'bar' }, createdAt }]);
        });
    });

    describe('versions', () => {
        it('defaults the limit to 50 and caps it at 200, the same as events', async () => {
            const seenLimits: number[] = [];
            const boardRepository = {
                versions: async (_id: string, limit: number) => {
                    seenLimits.push(limit);
                    return [];
                },
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            await service.versions('0001', {});
            await service.versions('0001', { limit: 10000 });

            expect(seenLimits).toEqual([50, 200]);
        });

        it('returns whatever the repository reports, unmapped', async () => {
            const createdAt = DateTime.fromISO('2024-01-01T00:00:00.000Z');
            const versions: CardVersionSummary[] = [{ id: 'v1', message: 'create', createdAt }];
            const boardRepository = { versions: async () => versions } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            expect(await service.versions('0001', {})).toEqual(versions);
        });
    });

    // Card 0263. `usage` is a thin translation over `EventLog.usageByStage`, the same shape as
    // `events` above — the 404 guard mirrors `getById`'s own (AC5), and a card that exists but has
    // no usage recorded yet gets `usageByStage`'s zeros back in an ordinary 200 (AC4), not a refusal.
    describe('usage', () => {
        const zeroUsage = { total: { attempts: 0, inputTokens: 0, outputTokens: 0 }, stages: [] };

        it('translates a missing card into a 404 rather than letting it become a 500', async () => {
            const boardRepository = {
                read: async () => {
                    throw new CardNotFoundError('card 0001 does not exist');
                },
            } as unknown as BoardRepository;
            const eventLog = { usageByStage: async () => zeroUsage } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            await expect(service.usage('missing')).rejects.toMatchObject({ statusCode: 404 });
        });

        it('leaves any other error alone, rather than folding it into a 404', async () => {
            const boom = new Error('database is unreachable');
            const boardRepository = {
                read: async () => {
                    throw boom;
                },
            } as unknown as BoardRepository;
            const eventLog = { usageByStage: async () => zeroUsage } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            await expect(service.usage('0001')).rejects.toBe(boom);
        });

        it("reads usage for this board's project and the card that was actually found, not some other one", async () => {
            const found = card('0007');
            const boardRepository = { read: async () => found } as unknown as BoardRepository;
            let seenArgs: [string, string] | undefined;
            const eventLog = {
                usageByStage: async (project: string, id: string) => {
                    seenArgs = [project, id];
                    return zeroUsage;
                },
            } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            await service.usage('0007');

            expect(seenArgs).toEqual(['proj', '0007']);
        });

        it('returns whatever EventLog.usageByStage reports, unmapped, for a card with usage recorded', async () => {
            const found = card('0001');
            const boardRepository = { read: async () => found } as unknown as BoardRepository;
            const usage = {
                total: { attempts: 3, inputTokens: 300, outputTokens: 50 },
                stages: [{ stage: 'implementing', attempts: 3, inputTokens: 300, outputTokens: 50 }],
            };
            const eventLog = { usageByStage: async () => usage } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            expect(await service.usage('0001')).toEqual(usage);
        });

        it('returns zeros and an empty stages list, in a normal resolve rather than a 404, for a card with no usage events', async () => {
            const found = card('0001');
            const boardRepository = { read: async () => found } as unknown as BoardRepository;
            const eventLog = { usageByStage: async () => zeroUsage } as unknown as EventLog;
            const service = new BoardService(boardRepository, eventLog, config, worktrees);

            await expect(service.usage('0001')).resolves.toEqual(zeroUsage);
        });
    });

    // Card 0265. `diff` is a thin translation over `WorktreeManager.patchSinceFork` — the 404 guard
    // mirrors `getById`'s/`usage`'s own, and `patchSinceFork`'s own 400 refusal (a branch never cut)
    // is carried through unchanged rather than re-derived here.
    describe('diff', () => {
        it('translates a missing card into a 404 rather than letting it become a 500', async () => {
            const boardRepository = {
                read: async () => {
                    throw new CardNotFoundError('card 0001 does not exist');
                },
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            await expect(service.diff('missing')).rejects.toMatchObject({ statusCode: 404 });
        });

        it('leaves any other error alone, rather than folding it into a 404', async () => {
            const boom = new Error('database is unreachable');
            const boardRepository = {
                read: async () => {
                    throw boom;
                },
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, noHistory, config, worktrees);

            await expect(service.diff('0001')).rejects.toBe(boom);
        });

        it('resolves the branch the same way list/getById do, and diffs it against main', async () => {
            const found = card('0002', { title: 'Fix the thing', branch: undefined });
            const boardRepository = { read: async () => found } as unknown as BoardRepository;
            let seenArgs: [string, string] | undefined;
            const fakeWorktrees = {
                resolveBranch: worktrees.resolveBranch.bind(worktrees),
                patchSinceFork: async (branch: string, targetRef: string) => {
                    seenArgs = [branch, targetRef];
                    return { ok: true as const, base: 'base-sha', files: [], truncated: false };
                },
            } as unknown as WorktreeManager;
            const service = new BoardService(boardRepository, noHistory, config, fakeWorktrees);

            await service.diff('0002');

            expect(seenArgs).toEqual([worktrees.resolveBranch(found), 'main']);
        });

        it("carries patchSinceFork's own 400 refusal through unchanged, for a card whose branch has never been cut", async () => {
            const found = card('0001', { branch: 'card/0001-never-cut' });
            const boardRepository = { read: async () => found } as unknown as BoardRepository;
            const fakeWorktrees = {
                resolveBranch: () => 'card/0001-never-cut',
                patchSinceFork: async () => ({ ok: false as const, reason: 'card/0001-never-cut has no branch yet' }),
            } as unknown as WorktreeManager;
            const service = new BoardService(boardRepository, noHistory, config, fakeWorktrees);

            await expect(service.diff('0001')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: 'card/0001-never-cut has no branch yet' },
            });
        });

        it("returns patchSinceFork's own result unmapped, on success", async () => {
            const found = card('0001', { branch: 'card/0001' });
            const boardRepository = { read: async () => found } as unknown as BoardRepository;
            const files = [{ path: 'src/a.ts', status: 'modified' as const, patch: '@@ -1 +1 @@\n-a\n+b\n', truncated: false }];
            const fakeWorktrees = {
                resolveBranch: () => 'card/0001',
                patchSinceFork: async () => ({ ok: true as const, base: 'base-sha', files, truncated: false }),
            } as unknown as WorktreeManager;
            const service = new BoardService(boardRepository, noHistory, config, fakeWorktrees);

            await expect(service.diff('0001')).resolves.toEqual({ base: 'base-sha', files, truncated: false });
        });
    });
});
