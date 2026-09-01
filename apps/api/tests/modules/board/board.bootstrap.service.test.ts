import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { BoardBootstrapService } from '#modules/board/board.bootstrap.service.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { NON_STAGE_STATES, parseStages } from '#modules/stages/stage.config.js';
import { PostgresStageConfigStore } from '#modules/stages/stage.config.store.js';
import { seedStageConfig, testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;

beforeAll(() => {
    db = testDb();
});

afterAll(async () => {
    await db.destroy();
});

/**
 * `BoardBootstrapService` is the home of `wilson board init` (card 0076). `init` is a database
 * operation now: no board root to scaffold, just a project with no config row yet and a store over
 * it, so it is exercised against a real `PostgresStageConfigStore` since the config row it writes is
 * the whole point. The paths handed to `StaticBoardConfig` are never read.
 */
describe('BoardBootstrapService', () => {
    describe('init', () => {
        const freshProject = () => {
            const cfg = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
            return { cfg, store: new PostgresStageConfigStore(cfg, db) };
        };

        it('gives a fresh project a stage config `parseStages` accepts, with every route resolving (card 0060 regression)', async () => {
            const { cfg, store } = freshProject();
            const service = new BoardBootstrapService(cfg, store);

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
            const service = new BoardBootstrapService(cfg, store);

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
            const service = new BoardBootstrapService(cfg, store);
            await service.init();

            await expect(service.init()).rejects.toMatchObject({
                statusCode: 409,
                details: { reason: expect.stringContaining('already has a stage config') },
            });
            expect(await store.versions()).toHaveLength(1);
        });
    });
});
