import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { BoardService } from '#modules/board/board.service.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository, CardVersionSummary } from '#modules/board/board.repository.js';
import type { EventLog, CardEventRow } from '#modules/events/event.log.js';
import type { Card } from '#modules/board/card.js';

const config = new StaticBoardConfig('proj', '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}, sections: Card['sections'] = {}, body = 'body text'): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'implementing', dependsOn: [], retries: {}, ...overrides },
    sections,
    body,
});

/**
 * `BoardService` is a thin translation layer over `BoardRepository` and `EventLog`, so every test
 * here hands it hand-rolled fakes for those two collaborators — the same idiom
 * `postgres.board.repository.test.ts` uses for the parts of `EventLog` it doesn't need. The board
 * repository itself already has its own Postgres-backed tests; nothing here re-tests persistence.
 */
describe('BoardService', () => {
    describe('list', () => {
        it('maps board cards into summaries, leaving body and sections behind', async () => {
            const cards = [card('0001', { title: 'Ship it', stage: 'review', branch: 'card/0001', dependsOn: ['0000'] }, { Goal: 'x' }, 'the body')];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, {} as unknown as EventLog, config);

            const summaries = await service.list();

            expect(summaries).toEqual([{ id: '0001', title: 'Ship it', stage: 'review', branch: 'card/0001', dependsOn: ['0000'] }]);
            expect(summaries[0]).not.toHaveProperty('body');
            expect(summaries[0]).not.toHaveProperty('sections');
        });

        it('leaves branch undefined for a card that has none, rather than sending null', async () => {
            const cards = [card('0001', { branch: undefined })];
            const boardRepository = { list: async () => cards } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, {} as unknown as EventLog, config);

            const [summary] = await service.list();

            expect(summary.branch).toBeUndefined();
        });
    });

    describe('getById', () => {
        it('includes the body and kebab-cases every section heading', async () => {
            const found = card('0001', { title: 'Ship it', stage: 'review' }, { Goal: 'Do it.', 'Files in scope': '- src/a.ts' }, 'full body');
            const boardRepository = {
                read: async (id: string) => {
                    expect(id).toBe('0001');
                    return found;
                },
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, {} as unknown as EventLog, config);

            const detail = await service.getById('0001');

            expect(detail.body).toBe('full body');
            expect(detail.sections).toEqual({ goal: 'Do it.', 'files-in-scope': '- src/a.ts' });
        });

        it('translates a missing card into a 404 rather than letting it become a 500', async () => {
            const boardRepository = {
                read: async () => {
                    throw new CardNotFoundError('card 0001 does not exist');
                },
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, {} as unknown as EventLog, config);

            await expect(service.getById('missing')).rejects.toMatchObject({ statusCode: 404 });
        });

        it('leaves any other error alone, rather than folding it into a 404', async () => {
            const boom = new Error('database is unreachable');
            const boardRepository = {
                read: async () => {
                    throw boom;
                },
            } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, {} as unknown as EventLog, config);

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
            const service = new BoardService({} as unknown as BoardRepository, eventLog, config);

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
            const service = new BoardService({} as unknown as BoardRepository, eventLog, config);

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
            const service = new BoardService({} as unknown as BoardRepository, eventLog, config);

            await service.events('0007', {});

            expect(seenArgs).toEqual(['proj', '0007']);
        });

        it('maps each event row into the wire shape unchanged', async () => {
            const createdAt = DateTime.fromISO('2024-01-01T00:00:00.000Z');
            const rows: CardEventRow[] = [{ id: '1', type: 'stage.passed', stage: 'implementing', payload: { foo: 'bar' }, createdAt }];
            const eventLog = { tail: async () => rows } as unknown as EventLog;
            const service = new BoardService({} as unknown as BoardRepository, eventLog, config);

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
            const service = new BoardService(boardRepository, {} as unknown as EventLog, config);

            await service.versions('0001', {});
            await service.versions('0001', { limit: 10000 });

            expect(seenLimits).toEqual([50, 200]);
        });

        it('returns whatever the repository reports, unmapped', async () => {
            const createdAt = DateTime.fromISO('2024-01-01T00:00:00.000Z');
            const versions: CardVersionSummary[] = [{ id: 'v1', message: 'create', createdAt }];
            const boardRepository = { versions: async () => versions } as unknown as BoardRepository;
            const service = new BoardService(boardRepository, {} as unknown as EventLog, config);

            expect(await service.versions('0001', {})).toEqual(versions);
        });
    });
});
