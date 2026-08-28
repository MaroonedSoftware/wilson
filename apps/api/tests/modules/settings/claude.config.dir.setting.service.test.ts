import { describe, expect, it, vi } from 'vitest';
import { ClaudeConfigDirSettingService } from '#modules/settings/claude.config.dir.setting.service.js';
import { CLAUDE_CONFIG_DIR } from '#modules/settings/claude.config.dir.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

/**
 * A `SettingsStore` fake that actually remembers a write, the same way `poller.interval.setting.
 * service.test.ts`'s does — `ClaudeConfigDirSettingService.set` both persists and echoes back
 * through the same value, so a fake that only stubbed `get` in isolation from `set` would not catch
 * a write that silently failed to update what a following `get` observes.
 */
const fakeSettings = (initial?: string): { store: SettingsStore; set: ReturnType<typeof vi.fn> } => {
    let value = initial;
    const set = vi.fn(async (_definition: unknown, next: string | undefined) => {
        value = next;
    });
    const store = { get: vi.fn(async () => value), set } as unknown as SettingsStore;
    return { store, set };
};

describe('ClaudeConfigDirSettingService.get', () => {
    it('reports null when the setting is unset', async () => {
        const { store } = fakeSettings(undefined);
        const service = new ClaudeConfigDirSettingService(store);

        await expect(service.get()).resolves.toEqual({ configDir: null });
    });

    it('reports whatever the store currently resolves', async () => {
        const { store } = fakeSettings('/home/operator/.claude-wilson');
        const service = new ClaudeConfigDirSettingService(store);

        await expect(service.get()).resolves.toEqual({ configDir: '/home/operator/.claude-wilson' });
    });
});

/**
 * Constraint: "Validate what can be validated cheaply, and refuse with a sentence" — an absolute
 * path is checkable, so this is where that refusal has to live and where a test can prove it
 * without a browser at all.
 */
describe('ClaudeConfigDirSettingService.set', () => {
    it('persists an absolute path through SettingsStore keyed by CLAUDE_CONFIG_DIR, then echoes it back', async () => {
        const { store, set } = fakeSettings(undefined);
        const service = new ClaudeConfigDirSettingService(store);

        const result = await service.set({ configDir: '/home/operator/.claude-wilson' });

        expect(set).toHaveBeenCalledWith(CLAUDE_CONFIG_DIR, '/home/operator/.claude-wilson');
        expect(result).toEqual({ configDir: '/home/operator/.claude-wilson' });
    });

    it('refuses a relative path with a 400 naming the offending value in the reason, and writes nothing', async () => {
        const { store, set } = fakeSettings(undefined);
        const service = new ClaudeConfigDirSettingService(store);

        await expect(service.set({ configDir: 'relative/claude-dir' })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('relative/claude-dir') },
        });
        expect(set).not.toHaveBeenCalled();
    });

    it('refuses a bare relative segment like "." the same way', async () => {
        const { store, set } = fakeSettings(undefined);
        const service = new ClaudeConfigDirSettingService(store);

        await expect(service.set({ configDir: '.' })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('absolute path') },
        });
        expect(set).not.toHaveBeenCalled();
    });

    it('leaves the previously persisted value untouched when the write is refused', async () => {
        const { store, set } = fakeSettings('/already/authenticated');
        const service = new ClaudeConfigDirSettingService(store);

        await expect(service.set({ configDir: 'not/absolute' })).rejects.toMatchObject({ statusCode: 400 });
        expect(set).not.toHaveBeenCalled();
        await expect(service.get()).resolves.toEqual({ configDir: '/already/authenticated' });
    });

    it('unsets the directory without running the absolute-path check when configDir is null', async () => {
        const { store, set } = fakeSettings('/home/operator/.claude-wilson');
        const service = new ClaudeConfigDirSettingService(store);

        const result = await service.set({ configDir: null });

        expect(set).toHaveBeenCalledWith(CLAUDE_CONFIG_DIR, undefined);
        expect(result).toEqual({ configDir: null });
        await expect(service.get()).resolves.toEqual({ configDir: null });
    });
});
