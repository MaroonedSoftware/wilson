import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { BoardBootstrapService } from '#modules/board/board.bootstrap.service.js';
import { BoardImporter } from '#modules/board/board.importer.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { NON_STAGE_STATES, loadStages } from '#modules/stages/stage.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
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
 * stub in place of one; `import` needs a real `BoardImporter` against the test database, the same
 * idiom `board.write.service.test.ts` uses for collaborators this card's tests actually rely on.
 */
describe('BoardBootstrapService', () => {
    describe('init', () => {
        it('scaffolds an empty board root into a config `loadStages` accepts, with every route resolving (card 0060 regression)', async () => {
            const root = await freshRoot();
            const service = new BoardBootstrapService(config(root), {} as unknown as BoardImporter);

            const result = await service.init();

            expect(result.stages.length).toBeGreaterThan(0);
            expect(result.nonStages).toEqual([...NON_STAGE_STATES]);

            // The acceptance bar itself: `loadStages` must accept the exact file `init` just wrote,
            // with every route it configures resolving to a known state.
            const stages = await loadStages(root);
            expect(stages.stages.map(s => s.name)).toEqual(result.stages);
            const known = new Set<string>([...NON_STAGE_STATES, ...stages.stages.map(s => s.name)]);
            for (const stage of stages.stages) {
                expect(known.has(stage.onPass)).toBe(true);
                expect(known.has(stage.onFail)).toBe(true);
            }
        });

        it('refuses with a 409 when a stages.yaml already exists at the root, writing nothing else', async () => {
            const root = await freshRoot();
            await mkdir(join(root, 'config'), { recursive: true });
            await writeFile(join(root, 'config', 'stages.yaml'), 'sentinel: true\n', 'utf8');
            const service = new BoardBootstrapService(config(root), {} as unknown as BoardImporter);

            await expect(service.init()).rejects.toMatchObject({
                statusCode: 409,
                details: { reason: expect.stringContaining('already initialised') },
            });

            // Refused before any scaffolding: the existing file is untouched and nothing else lands
            // beside it — this is "init scaffolds, it does not reset" made concrete.
            expect(await readFile(join(root, 'config', 'stages.yaml'), 'utf8')).toBe('sentinel: true\n');
            expect(existsSync(join(root, 'cards'))).toBe(false);
            expect(existsSync(join(root, 'README.md'))).toBe(false);
            expect(existsSync(join(root, '.gitignore'))).toBe(false);
        });
    });

    describe('import', () => {
        it('answers no legacy cards found with a 400, never reaching the importer’s write path', async () => {
            const root = await freshRoot();
            const cfg = config(root);
            const importer = new BoardImporter(cfg, db, fakeLogger());
            const service = new BoardBootstrapService(cfg, importer);

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
            const service = new BoardBootstrapService(cfg, importer);

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
            const service = new BoardBootstrapService(cfg, importer);

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
            const service = new BoardBootstrapService(cfg, importer);
            await service.import({});

            await expect(service.import({})).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining(`project "${cfg.project}" already has cards`) },
            });
        });
    });
});
