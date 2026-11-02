import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '@maroonedsoftware/appconfig';
import type { Kysely } from 'kysely';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';
import type { GitHubApp } from '#modules/github/github.app.js';
import { GITHUB_APP_ID } from '#modules/settings/github.app.id.setting.js';
import { GitHubAppSettingService } from '#modules/settings/github.app.setting.service.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const realStore = (env: Record<string, string> = {}): SettingsStore =>
    new SettingsStore(new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run'), db, new AppConfig(env));

const fake = (initial?: string, hasPrivateKey = false) => {
    let value = initial;
    const set = vi.fn(async (_definition: unknown, next: string | undefined) => {
        value = next;
    });
    const store = { get: vi.fn(async () => value), set } as unknown as SettingsStore;
    return { service: new GitHubAppSettingService(store, { hasPrivateKey: async () => hasPrivateKey } as unknown as GitHubApp), set };
};

describe('GitHubAppSettingService', () => {
    it('answers null for an unset id, and whether the key is in place', async () => {
        expect(await fake(undefined, true).service.get()).toEqual({ appId: null, keyInstalled: true });
    });

    it('saves an id and answers with what is now stored', async () => {
        const { service, set } = fake();

        expect(await service.set({ appId: '123456' })).toEqual({ appId: '123456', keyInstalled: false });
        expect(set).toHaveBeenCalledWith(GITHUB_APP_ID, '123456');
    });

    it('clears the id', async () => {
        const { service, set } = fake('123456');

        expect(await service.set({ appId: null })).toEqual({ appId: null, keyInstalled: false });
        expect(set).toHaveBeenCalledWith(GITHUB_APP_ID, undefined);
    });

    it('refuses anything that is not a number, saving nothing', async () => {
        const { service, set } = fake();

        await expect(service.set({ appId: 'Iv1.abc' })).rejects.toMatchObject({ statusCode: 400 });
        expect(set).not.toHaveBeenCalled();
    });
});

/** Against the real table: a fake store never sees what `JSON.stringify(undefined)` does to the insert. */
describe('GitHubAppSettingService against the database', () => {
    const service = (store: SettingsStore) => new GitHubAppSettingService(store, { hasPrivateKey: async () => false } as unknown as GitHubApp);

    it('clears a stored id', async () => {
        const store = realStore();
        await service(store).set({ appId: '123456' });

        expect(await service(store).set({ appId: null })).toEqual({ appId: null, keyInstalled: false });
        await expect(store.stored(GITHUB_APP_ID)).resolves.toBeUndefined();
    });

    it('clears nothing without failing', async () => {
        expect(await service(realStore()).set({ appId: null })).toEqual({ appId: null, keyInstalled: false });
    });

    it('answers with the environment value a cleared row falls back to', async () => {
        const store = realStore({ GITHUB_APP_ID: '999' });
        await service(store).set({ appId: '123456' });

        expect(await service(store).set({ appId: null })).toEqual({ appId: '999', keyInstalled: false });
    });
});
