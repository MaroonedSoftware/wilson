import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfig } from '@maroonedsoftware/appconfig';
import type { Kysely } from 'kysely';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { POLLER_ENABLED } from '#modules/settings/poller.enabled.setting.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const buildStore = (project: string, env: Record<string, string> = {}): SettingsStore => {
    const config = new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run');
    return new SettingsStore(config, db, new AppConfig(env));
};

describe('SettingsStore.stored', () => {
    it('ignores the environment variable, which `get` would fall back to', async () => {
        const store = buildStore(uniqueProject(), { POLLER_ENABLED: 'true' });

        await expect(store.get(POLLER_ENABLED)).resolves.toBe(true);
        await expect(store.stored(POLLER_ENABLED)).resolves.toBeUndefined();
    });

    it('returns the row once there is one', async () => {
        const store = buildStore(uniqueProject());

        await store.set(POLLER_ENABLED, true);

        await expect(store.stored(POLLER_ENABLED)).resolves.toBe(true);
    });
});

describe('SettingsStore.clear', () => {
    it('removes the row, so the environment variable applies again', async () => {
        const store = buildStore(uniqueProject(), { POLLER_ENABLED: 'true' });
        await store.set(POLLER_ENABLED, false);

        await store.clear(POLLER_ENABLED);

        await expect(store.stored(POLLER_ENABLED)).resolves.toBeUndefined();
        await expect(store.get(POLLER_ENABLED)).resolves.toBe(true);
    });
});

/**
 * Card 0106. `SettingsStore` is the one place the precedence this card exists for lives: a
 * `wilson.settings` row, else the environment variable, else the coded default. A fresh database
 * has no rows, so these first prove the pre-existing behaviour (env var, or nothing) is unchanged,
 * before the tests that prove the new thing — a row overriding it.
 */
describe('SettingsStore.get — no database row', () => {
    it('falls back to the coded default when the environment variable is unset too', async () => {
        const store = buildStore(uniqueProject());
        expect(await store.get(POLLER_ENABLED)).toBe(false);
    });

    /**
     * Acceptance criterion: "identical to today for both values of the environment variable —
     * tested for both."
     */
    it.each([
        ['true', true],
        ['1', true],
        ['false', false],
        ['0', false],
    ])('resolves the environment variable %s as %s, exactly as before this card existed', async (raw, expected) => {
        const store = buildStore(uniqueProject(), { POLLER_ENABLED: raw });
        expect(await store.get(POLLER_ENABLED)).toBe(expected);
    });
});

describe('SettingsStore.get/set — a database row', () => {
    it('a written value is read back exactly, even opposite the environment variable', async () => {
        const project = uniqueProject();
        const store = buildStore(project, { POLLER_ENABLED: 'false' });
        expect(await store.get(POLLER_ENABLED)).toBe(false);

        await store.set(POLLER_ENABLED, true);

        expect(await store.get(POLLER_ENABLED)).toBe(true);
    });

    it('a row set back to the environment variable’s own value still reads through the row, not around it', async () => {
        const project = uniqueProject();
        const store = buildStore(project, { POLLER_ENABLED: 'true' });
        await store.set(POLLER_ENABLED, false);

        expect(await store.get(POLLER_ENABLED)).toBe(false);
    });

    it('a row written for one project is invisible to a read for another project', async () => {
        const storeA = buildStore(uniqueProject());
        const storeB = buildStore(uniqueProject());

        await storeA.set(POLLER_ENABLED, true);

        expect(await storeB.get(POLLER_ENABLED)).toBe(false);
    });

    it('upserts rather than accumulating a row per write', async () => {
        const project = uniqueProject();
        const store = buildStore(project);

        await store.set(POLLER_ENABLED, true);
        await store.set(POLLER_ENABLED, false);
        await store.set(POLLER_ENABLED, true);

        const rows = await db
            .selectFrom('wilson.settings')
            .selectAll()
            .where('project', '=', project)
            .where('key', '=', POLLER_ENABLED.key)
            .execute();
        expect(rows).toHaveLength(1);
        expect(await store.get(POLLER_ENABLED)).toBe(true);
    });

    /**
     * The design constraint this card states outright: "The store should take a typed key and a
     * value without a schema change per setting, and adding the second must not mean rewriting the
     * first." Proven here with a second, differently-typed `SettingDefinition` nothing in
     * `settings.module.ts` had to be told about in advance, coexisting with `POLLER_ENABLED` in the
     * same project without either interfering with the other.
     */
    it('stores a second, differently-typed setting under the same store with no schema change', async () => {
        const project = uniqueProject();
        const store = buildStore(project);
        const POLLER_INTERVAL_MS: SettingDefinition<number> = {
            key: 'poller-interval-ms',
            envVar: 'POLLER_INTERVAL_MS',
            parseEnv: raw => Number(raw),
            defaultValue: 30_000,
        };

        expect(await store.get(POLLER_INTERVAL_MS)).toBe(30_000);

        await store.set(POLLER_INTERVAL_MS, 5_000);
        await store.set(POLLER_ENABLED, true);

        expect(await store.get(POLLER_INTERVAL_MS)).toBe(5_000);
        expect(await store.get(POLLER_ENABLED)).toBe(true);
    });
});
