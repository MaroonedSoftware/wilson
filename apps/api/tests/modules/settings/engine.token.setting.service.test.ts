import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { EngineTokenSettingService } from '#modules/settings/engine.token.setting.service.js';
import { ENGINE_TOKEN } from '#modules/settings/engine.token.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

/** A `SettingsStore` fake that remembers a write, so a test sees exactly what reached the row. */
const fakeSettings = () => {
    const state: { row?: string } = {};
    const store = {
        stored: vi.fn(async () => state.row),
        set: vi.fn(async (_definition: unknown, value: string) => {
            state.row = value;
        }),
        clear: vi.fn(async () => {
            delete state.row;
        }),
    } as unknown as SettingsStore;
    return { store, state };
};

const newProvider = () => new EncryptionProvider(randomBytes(32));

describe('EngineTokenSettingService', () => {
    const inherited = process.env.CLAUDE_CODE_OAUTH_TOKEN;

    beforeEach(() => {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    });

    afterEach(() => {
        if (inherited === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = inherited;
    });

    it('resolves to undefined when nothing is saved', async () => {
        const { store } = fakeSettings();

        await expect(new EngineTokenSettingService(store, newProvider()).resolve()).resolves.toBeUndefined();
    });

    it('stores ciphertext, and resolves back to the token', async () => {
        const { store, state } = fakeSettings();
        const service = new EngineTokenSettingService(store, newProvider());

        await service.save('sk-ant-oat-secret');

        expect(store.set).toHaveBeenCalledWith(ENGINE_TOKEN, state.row);
        expect(state.row).not.toContain('sk-ant-oat-secret');
        await expect(service.resolve()).resolves.toBe('sk-ant-oat-secret');
    });

    it('trims what a paste brings with it', async () => {
        const { store } = fakeSettings();
        const service = new EngineTokenSettingService(store, newProvider());

        await service.save('  sk-ant-oat-secret\n');

        await expect(service.resolve()).resolves.toBe('sk-ant-oat-secret');
    });

    it.each(['', '   ', 'two words', 'two\nlines'])('refuses %j, and stores nothing', async token => {
        const { store } = fakeSettings();
        const service = new EngineTokenSettingService(store, newProvider());

        await expect(service.save(token)).rejects.toMatchObject({ details: { reason: expect.stringContaining('single word') } });
        expect(store.set).not.toHaveBeenCalled();
    });

    it('names the encryption key when a row will not decrypt', async () => {
        const { store } = fakeSettings();
        await new EngineTokenSettingService(store, newProvider()).save('sk-ant-oat-secret');

        await expect(new EngineTokenSettingService(store, newProvider()).resolve()).rejects.toThrow(/encryption key/);
    });

    it('clears a row that will not decrypt', async () => {
        const { store } = fakeSettings();
        await new EngineTokenSettingService(store, newProvider()).save('sk-ant-oat-secret');
        const afterKeyLoss = new EngineTokenSettingService(store, newProvider());

        await afterKeyLoss.clear();

        await expect(afterKeyLoss.resolve()).resolves.toBeUndefined();
    });

    it('reports where the sign-in comes from, the saved token first', async () => {
        const { store } = fakeSettings();
        const service = new EngineTokenSettingService(store, newProvider());

        await expect(service.source()).resolves.toBe('none');

        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'environment-token';
        await expect(service.source()).resolves.toBe('environment');

        await service.save('sk-ant-oat-secret');
        await expect(service.source()).resolves.toBe('database');
    });
});
