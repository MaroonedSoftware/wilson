import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import { ensureSettingsTable } from './ensure.settings.table.js';

let db: Kysely<DB>;
beforeAll(async () => {
    db = testDb();
    await ensureSettingsTable(db);
});
afterAll(async () => {
    await db.destroy();
});

/** A minimal `AppConfig`: `optionalConfigString` only ever calls `.get(key, '')`. */
const fakeAppConfig = (env: Record<string, string> = {}): AppConfig => ({ get: (key: string, fallback = '') => env[key] ?? fallback }) as unknown as AppConfig;

const buildConfig = () => new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');

/**
 * A setting of `SettingsStore`'s own — separate from the real `POLLER_ENABLED` (card 0106's one
 * shipped setting) — so these tests exercise the generic store rather than anything poller-shaped.
 * Adding this required no change to `SettingsStore` at all, which is the "design for the next
 * setting" constraint made concrete.
 */
const TEST_SETTING: SettingDefinition<boolean> = {
    key: 'test-boolean-setting',
    envVar: 'TEST_BOOLEAN_SETTING',
    parseEnv: raw => raw.trim().toLowerCase() === 'true' || raw.trim() === '1',
    defaultValue: false,
};

/**
 * Card 0106. `SettingsStore` is the generic part of "operational settings live in the database":
 * database row -> environment variable -> coded default, keyed by `(project, key)`, typed by
 * whatever `SettingDefinition<T>` a caller hands it. `PollerSettingService`
 * (poller.setting.service.test.ts) is what makes one particular setting — the poller's on/off
 * switch — actually do something; this file is only about the resolution and persistence
 * underneath it.
 */
describe('SettingsStore', () => {
    it('resolves the coded default when there is no database row and no environment variable', async () => {
        const store = new SettingsStore(buildConfig(), db, fakeAppConfig());

        expect(await store.get(TEST_SETTING)).toBe(false);
    });

    it.each(['true', 'false'])('resolves the environment variable (%s) when there is no database row, identically for both values', async raw => {
        const store = new SettingsStore(buildConfig(), db, fakeAppConfig({ TEST_BOOLEAN_SETTING: raw }));

        expect(await store.get(TEST_SETTING)).toBe(raw === 'true');
    });

    it('a database row overrides the environment variable', async () => {
        const store = new SettingsStore(buildConfig(), db, fakeAppConfig({ TEST_BOOLEAN_SETTING: 'false' }));

        await store.set(TEST_SETTING, true);

        expect(await store.get(TEST_SETTING)).toBe(true);
    });

    it('set() upserts rather than accumulating a row per write', async () => {
        const config = buildConfig();
        const store = new SettingsStore(config, db, fakeAppConfig());

        await store.set(TEST_SETTING, true);
        await store.set(TEST_SETTING, false);

        const rows = await db.selectFrom('runner.settings').selectAll().where('project', '=', config.project).where('key', '=', TEST_SETTING.key).execute();
        expect(rows).toHaveLength(1);
        expect(await store.get(TEST_SETTING)).toBe(false);
    });

    it("scopes rows by project, so one project's write does not affect another's read", async () => {
        const appConfig = fakeAppConfig();
        const storeA = new SettingsStore(buildConfig(), db, appConfig);
        const storeB = new SettingsStore(buildConfig(), db, appConfig);

        await storeA.set(TEST_SETTING, true);

        expect(await storeB.get(TEST_SETTING)).toBe(false);
    });
});
