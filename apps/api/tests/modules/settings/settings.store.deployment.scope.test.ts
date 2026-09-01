import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfig } from '@maroonedsoftware/appconfig';
import type { Kysely } from 'kysely';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

/**
 * Card 0152. Before this card every `SettingsStore` row was keyed by `BoardConfig.project` — a
 * setting written for one project was invisible from another, full stop (see the "invisible to a
 * read for another project" case in settings.store.test.ts). `SettingDefinition.scope` is new, and
 * these prove `SettingsStore` actually treats `'deployment'` differently from `'project'`: the row
 * lives under a fixed identity rather than the writing project, so any project reads the same value
 * back.
 *
 * Each case builds its own one-off `SettingDefinition` with a random key, the same way
 * settings.store.test.ts's "stores a second, differently-typed setting" case does, rather than
 * importing a real setting like `CARD_STAGE_CONCURRENCY`. That real setting's row lives under the
 * one fixed deployment identity too — reusing its key here would mean every run of this file
 * fighting over the same row a real `card-stage-concurrency` write (or another test file's) might
 * also be touching, instead of a row this test alone owns.
 */
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const buildStore = (project: string): SettingsStore => {
    const config = new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run');
    return new SettingsStore(config, db, new AppConfig({}));
};

const deploymentSetting = (): SettingDefinition<number> => ({
    key: `deployment-scope-test-${randomUUID()}`,
    scope: 'deployment',
    envVar: 'UNUSED_DEPLOYMENT_SCOPE_TEST_ENV_VAR',
    parseEnv: raw => Number(raw),
    defaultValue: 0,
});

describe('SettingsStore.get/set — a deployment-scoped setting', () => {
    it('a row written while one project is current reads back identically from another project', async () => {
        const setting = deploymentSetting();
        const storeA = buildStore(uniqueProject());
        const storeB = buildStore(uniqueProject());

        await storeA.set(setting, 9);

        expect(await storeB.get(setting)).toBe(9);
    });

    it('a write from a second project overwrites the same row rather than creating a per-project one', async () => {
        const setting = deploymentSetting();
        const storeA = buildStore(uniqueProject());
        const storeB = buildStore(uniqueProject());

        await storeA.set(setting, 4);
        await storeB.set(setting, 6);

        expect(await storeA.get(setting)).toBe(6);
        expect(await storeB.get(setting)).toBe(6);
    });

    /**
     * The mechanism behind the two behavioural tests above: the row is not keyed by the writing
     * project at all. `'__deployment__'` is the reserved value `SettingsStore.DEPLOYMENT_SCOPE`
     * (settings.store.ts) and the migration that carries existing rows onto it
     * (data/migrations/20260829120000_deployment_scoped_settings.sql) both agree on.
     */
    it('is stored under the reserved deployment project, not the writing project', async () => {
        const setting = deploymentSetting();
        const project = uniqueProject();
        const store = buildStore(project);

        await store.set(setting, 5);

        const ownRow = await db
            .selectFrom('runner.settings')
            .selectAll()
            .where('project', '=', project)
            .where('key', '=', setting.key)
            .executeTakeFirst();
        expect(ownRow).toBeUndefined();

        const deploymentRow = await db
            .selectFrom('runner.settings')
            .selectAll()
            .where('project', '=', '__deployment__')
            .where('key', '=', setting.key)
            .executeTakeFirst();
        expect(deploymentRow?.value).toBe(5);
    });
});
