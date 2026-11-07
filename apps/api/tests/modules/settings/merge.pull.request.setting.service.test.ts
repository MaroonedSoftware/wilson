import { describe, expect, it, vi } from 'vitest';
import { MergePullRequestSettingService } from '#modules/settings/merge.pull.request.setting.service.js';
import { MERGE_OPENS_PULL_REQUEST } from '#modules/settings/merge.pull.request.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

const fakeSettings = (initial: boolean) => {
    let value = initial;
    const set = vi.fn(async (_definition: unknown, next: boolean) => {
        value = next;
    });
    return { store: { get: vi.fn(async () => value), set } as unknown as SettingsStore, set };
};

describe('MergePullRequestSettingService', () => {
    it('reports what the store resolves', async () => {
        await expect(new MergePullRequestSettingService(fakeSettings(false).store).get()).resolves.toEqual({ enabled: false });
    });

    it('persists through the store keyed by MERGE_OPENS_PULL_REQUEST, and a following read sees it', async () => {
        const { store, set } = fakeSettings(false);
        const service = new MergePullRequestSettingService(store);

        await expect(service.set({ enabled: true })).resolves.toEqual({ enabled: true });

        expect(set).toHaveBeenCalledWith(MERGE_OPENS_PULL_REQUEST, true);
        await expect(service.get()).resolves.toEqual({ enabled: true });
    });
});
