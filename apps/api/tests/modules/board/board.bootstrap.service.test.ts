import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { BoardBootstrapService } from '#modules/board/board.bootstrap.service.js';
import { BoardImporter } from '#modules/board/board.importer.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { NON_STAGE_STATES, parseStages } from '#modules/stages/stage.config.js';
import { PostgresStageConfigStore, type StageConfigStore } from '#modules/stages/stage.config.store.js';
import { seedStageConfig, testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

const fakeLogger = (): Logger =>
    ({
        warn: () => {},
        error: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
    }) as unknown as Logger;

/** A fresh, never-scaffolded board root for one test. */
const freshRoot = async (): Promise<string> => {
    const base = await mkdtemp(join(tmpdir(), 'board-bootstrap-'));
    return join(base, 'board');
};

const config = (root: string) => new StaticBoardConfig(uniqueProject(), root, '/tmp/code', '/tmp/wt', '/tmp/run');

/** A legacy card file, the shape `LegacyBoardFiles`/`parseCard` reads under `boardRoot/cards`. */
const writeLegacyCard = async (root: string, id: string, overrides: Record<string, unknown> = {}, body = 'body text') => {
    const fm: Record<string, unknown> = { id, title: `card ${id}`, stage: 'implementing', dependsOn: [], retries: {}, ...overrides };
    await mkdir(join(root, 'cards'), { recursive: true });
    const yaml = Object.entries(fm)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join('\n');
    await writeFile(join(root, 'cards', `${id}.md`), `---\n${yaml}\n---\n${body}`, 'utf8');
};

let db: Kysely<DB>;

beforeAll(() => {
    db = testDb();
});

afterAll(async () => {
    await db.destroy();
});

/**
 * `BoardBootstrapService` is the new home for `wilson board init`/`wilson board import` (card 0076) —
 * neither ran through the API before. `init` never touches the importer, so it is exercised with a
 * stub in place of one, against a real `PostgresStageConfigStore` since the config row it writes is
 * the whole point; `import` never touches the stage config, so it gets a stub store and a real
 * `BoardImporter` against the test database, the same idiom `board.write.service.test.ts` uses for
 * collaborators this card's tests actually rely on.
 */
describe('BoardBootstrapService', () => {
    describe('init', () => {
        /**
         * `init` is a database operation now: no board root to scaffold, just a project with no
         * config row yet and a store over it. The root handed to `config` is never read.
         */
        const freshProject = () => {
            const cfg = config('/tmp/board');
            return { cfg, store: new PostgresStageConfigStore(cfg, db) };
        };

        it('gives a fresh project a stage config `parseStages` accepts, with every route resolving (card 0060 regression)', async () => {
            const { cfg, store } = freshProject();
            const service = new BoardBootstrapService(cfg, store, {} as unknown as BoardImporter);

            const result = await service.init();

            expect(result.stages).toEqual(['implementing']);
            expect(result.nonStages).toEqual([...NON_STAGE_STATES]);

            // The acceptance bar itself: `parseStages` must accept the exact document `init` just
            // stored, with every route it configures resolving to a known state.
            const stored = await store.read();
            expect(stored?.message).toBe('Initialise board');
            const stages = parseStages(stored!.yaml);
            expect(stages.stages.map(s => s.name)).toEqual(result.stages);
            const known = new Set<string>([...NON_STAGE_STATES, ...stages.stages.map(s => s.name)]);
            for (const stage of stages.stages) {
                expect(known.has(stage.onPass)).toBe(true);
                expect(known.has(stage.onFail)).toBe(true);
            }
        });

        it('refuses with a 409 when the project already has a stage config, writing no second row', async () => {
            const { cfg, store } = freshProject();
            await seedStageConfig(db, cfg.project, 'sentinel: true\n', 'sentinel');
            const service = new BoardBootstrapService(cfg, store, {} as unknown as BoardImporter);

            await expect(service.init()).rejects.toMatchObject({
                statusCode: 409,
                details: { reason: expect.stringContaining(`project "${cfg.project}" already has a stage config`) },
            });

            // Refused before anything is stored: the existing document is still the current one and
            // nothing lands beside it — this is "init scaffolds, it does not reset" made concrete.
            expect((await store.read())?.yaml).toBe('sentinel: true\n');
            expect(await store.versions()).toHaveLength(1);
        });

        it('refuses a second init the same way, leaving the first document as the only version', async () => {
            const { cfg, store } = freshProject();
            const service = new BoardBootstrapService(cfg, store, {} as unknown as BoardImporter);
            await service.init();

            await expect(service.init()).rejects.toMatchObject({
                statusCode: 409,
                details: { reason: expect.stringContaining('already has a stage config') },
            });
            expect(await store.versions()).toHaveLength(1);
        });
    });

    describe('import', () => {
        it('answers no legacy cards found with a 400, never reaching the importer’s write path', async () => {
            const root = await freshRoot();
            const cfg = config(root);
            const importer = new BoardImporter(cfg, db, fakeLogger());
            const service = new BoardBootstrapService(cfg, {} as StageConfigStore, importer);

            await expect(service.import({})).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining(`no cards found under ${root}/cards`) },
            });
        });

        it('a dry run reports what it would do and inserts nothing', async () => {
            const root = await freshRoot();
            const cfg = config(root);
            await writeLegacyCard(root, '0001');
            await writeLegacyCard(root, '0002', { dependsOn: ['0001'], planSha: 'legacy-sha' });
            const importer = new BoardImporter(cfg, db, fakeLogger());
            const service = new BoardBootstrapService(cfg, {} as StageConfigStore, importer);

            const report = await service.import({ dryRun: true });

            expect(report).toEqual({ cards: 2, dependencies: 1, unpinned: ['0002'], skipped: true });
            const rows = await db.selectFrom('runner.cards').select('id').where('project', '=', cfg.project).execute();
            expect(rows).toHaveLength(0);
        });

        it('imports for real when dryRun is omitted, and the response carries the card count and re-pinned ids', async () => {
            const root = await freshRoot();
            const cfg = config(root);
            await writeLegacyCard(root, '0001');
            await writeLegacyCard(root, '0002', { dependsOn: ['0001'], planSha: 'legacy-sha' });
            const importer = new BoardImporter(cfg, db, fakeLogger());
            const service = new BoardBootstrapService(cfg, {} as StageConfigStore, importer);

            const report = await service.import({});

            expect(report).toEqual({ cards: 2, dependencies: 1, unpinned: ['0002'], skipped: false });
            const rows = await db.selectFrom('runner.cards').select('id').where('project', '=', cfg.project).execute();
            expect(rows).toHaveLength(2);
        });

        it('wraps the importer’s refusal of a board that already has cards as a 400, as it does today', async () => {
            const root = await freshRoot();
            const cfg = config(root);
            await writeLegacyCard(root, '0001');
            const importer = new BoardImporter(cfg, db, fakeLogger());
            const service = new BoardBootstrapService(cfg, {} as StageConfigStore, importer);
            await service.import({});

            await expect(service.import({})).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining(`project "${cfg.project}" already has cards`) },
            });
        });
    });
});
