import { describe, expect, it, vi } from 'vitest';
import { NotifyWebhookSettingService } from '#modules/settings/notify.webhook.setting.service.js';
import { NOTIFY_WEBHOOK_URL } from '#modules/settings/notify.webhook.url.setting.js';
import { NOTIFY_BASE_URL } from '#modules/settings/notify.base.url.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { Logger } from '@maroonedsoftware/logger';

/**
 * A `SettingsStore` fake that actually remembers a write, keyed by which `SettingDefinition` it was
 * given — `NotifyWebhookSettingService` reads and writes two distinct keys (`NOTIFY_WEBHOOK_URL`,
 * `NOTIFY_BASE_URL`) through the same store, so a fake that only tracked one value would not catch
 * the two being confused with each other.
 */
const fakeStore = (initial: { webhookUrl?: string; baseUrl?: string } = {}): { store: SettingsStore; set: ReturnType<typeof vi.fn> } => {
    const values = new Map<string, unknown>();
    if (initial.webhookUrl !== undefined) values.set(NOTIFY_WEBHOOK_URL.key, initial.webhookUrl);
    if (initial.baseUrl !== undefined) values.set(NOTIFY_BASE_URL.key, initial.baseUrl);

    const set = vi.fn(async (definition: SettingDefinition<unknown>, value: unknown) => {
        values.set(definition.key, value);
    });
    const get = vi.fn(async (definition: SettingDefinition<unknown>) => values.get(definition.key));
    return { store: { get, set } as unknown as SettingsStore, set };
};

const fakeConfig = (): BoardConfig => ({ notifyWebhookUrl: undefined, notifyBaseUrl: undefined }) as unknown as BoardConfig;

const fakeLogger = (): Logger & { warn: ReturnType<typeof vi.fn> } =>
    ({
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

describe('NotifyWebhookSettingService.get', () => {
    it('reports null for both fields when neither is set', async () => {
        const { store } = fakeStore();
        const service = new NotifyWebhookSettingService(store, fakeConfig(), fakeLogger());

        await expect(service.get()).resolves.toEqual({ webhookUrl: null, baseUrl: null });
    });

    it('reports whatever the store currently resolves for each field', async () => {
        const { store } = fakeStore({ webhookUrl: 'https://93.184.216.34/hook', baseUrl: 'https://board.example/' });
        const service = new NotifyWebhookSettingService(store, fakeConfig(), fakeLogger());

        await expect(service.get()).resolves.toEqual({ webhookUrl: 'https://93.184.216.34/hook', baseUrl: 'https://board.example/' });
    });
});

/**
 * Card 0107's write-time check: "Reject at write, and again at use" — this is the write half, and
 * the one that gives an operator an immediate error rather than a silently-disabled webhook.
 */
describe('NotifyWebhookSettingService.set', () => {
    it('persists a webhook resolving to a safe address, pushes it onto the live BoardConfig, and echoes it back', async () => {
        const { store, set } = fakeStore();
        const config = fakeConfig();
        const service = new NotifyWebhookSettingService(store, config, fakeLogger());

        const result = await service.set({ webhookUrl: 'https://93.184.216.34/hook', baseUrl: 'https://board.example' });

        expect(set).toHaveBeenCalledWith(NOTIFY_WEBHOOK_URL, 'https://93.184.216.34/hook');
        expect(set).toHaveBeenCalledWith(NOTIFY_BASE_URL, 'https://board.example');
        expect(config.notifyWebhookUrl).toBe('https://93.184.216.34/hook');
        expect(config.notifyBaseUrl).toBe('https://board.example');
        expect(result).toEqual({ webhookUrl: 'https://93.184.216.34/hook', baseUrl: 'https://board.example' });
    });

    it('refuses a webhook resolving to a private address with a 400 naming the rule and the address, and persists nothing', async () => {
        const { store, set } = fakeStore();
        const config = fakeConfig();
        const service = new NotifyWebhookSettingService(store, config, fakeLogger());

        await expect(service.set({ webhookUrl: 'https://10.1.2.3/hook', baseUrl: null })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('private') },
        });
        await expect(service.set({ webhookUrl: 'https://10.1.2.3/hook', baseUrl: null })).rejects.toMatchObject({
            details: { reason: expect.stringContaining('10.1.2.3') },
        });
        expect(set).not.toHaveBeenCalled();
        expect(config.notifyWebhookUrl).toBeUndefined();
    });

    it('refuses a plain http webhook the same way, and persists nothing', async () => {
        const { store, set } = fakeStore();
        const service = new NotifyWebhookSettingService(store, fakeConfig(), fakeLogger());

        await expect(service.set({ webhookUrl: 'http://example.com/hook', baseUrl: null })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('https') },
        });
        expect(set).not.toHaveBeenCalled();
    });

    it('unsets the webhook without running the destination check when webhookUrl is null', async () => {
        const { store, set } = fakeStore({ webhookUrl: 'https://93.184.216.34/hook' });
        const config = fakeConfig();
        const service = new NotifyWebhookSettingService(store, config, fakeLogger());

        const result = await service.set({ webhookUrl: null, baseUrl: null });

        expect(set).toHaveBeenCalledWith(NOTIFY_WEBHOOK_URL, undefined);
        expect(config.notifyWebhookUrl).toBeUndefined();
        expect(result).toEqual({ webhookUrl: null, baseUrl: null });
    });
});

/**
 * Called from `set` above, and once at boot (`SettingsModule`'s `start` hook) — the one place a
 * value the settings store currently resolves to becomes (or stops being) what `Notifier` will
 * actually use.
 */
describe('NotifyWebhookSettingService.applyCurrentValue', () => {
    it('pushes a currently-valid stored webhook onto BoardConfig', async () => {
        const { store } = fakeStore({ webhookUrl: 'https://93.184.216.34/hook', baseUrl: 'https://board.example' });
        const config = fakeConfig();
        const service = new NotifyWebhookSettingService(store, config, fakeLogger());

        const result = await service.applyCurrentValue();

        expect(config.notifyWebhookUrl).toBe('https://93.184.216.34/hook');
        expect(config.notifyBaseUrl).toBe('https://board.example');
        expect(result).toEqual({ webhookUrl: 'https://93.184.216.34/hook', baseUrl: 'https://board.example' });
    });

    it('treats a stored value that now resolves unsafely as unset — clears BoardConfig and logs once, not on every call', async () => {
        const { store } = fakeStore({ webhookUrl: 'https://169.254.169.254/hook', baseUrl: 'https://board.example' });
        const config = fakeConfig();
        config.notifyWebhookUrl = 'https://169.254.169.254/hook'; // as if a previous boot had already applied it
        const logger = fakeLogger();
        const service = new NotifyWebhookSettingService(store, config, logger);

        const first = await service.applyCurrentValue();
        const second = await service.applyCurrentValue();

        expect(config.notifyWebhookUrl).toBeUndefined();
        expect(first).toEqual({ webhookUrl: null, baseUrl: 'https://board.example' });
        expect(second).toEqual({ webhookUrl: null, baseUrl: 'https://board.example' });
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0]![0]).toContain('link-local');
    });

    it('never runs the destination check against baseUrl, which is passed through untouched', async () => {
        const { store } = fakeStore({ baseUrl: 'not even a url' });
        const config = fakeConfig();
        const service = new NotifyWebhookSettingService(store, config, fakeLogger());

        const result = await service.applyCurrentValue();

        expect(config.notifyBaseUrl).toBe('not even a url');
        expect(result.baseUrl).toBe('not even a url');
    });
});
