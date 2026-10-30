import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { GitHubApp } from '#modules/github/github.app.js';
import type { GitHubAppSetting, SetGitHubAppSettingRequest } from '#src/generated/settings.js';
import { GITHUB_APP_ID } from './github.app.id.setting.js';
import { SettingsStore } from './settings.store.js';

/** The GitHub App's id, and whether its private key is in place: the two things setting one up takes. */
@Injectable()
export class GitHubAppSettingService {
    constructor(
        private readonly settings: SettingsStore,
        private readonly app: GitHubApp,
    ) {}

    async get(): Promise<GitHubAppSetting> {
        const [appId, keyInstalled] = await Promise.all([this.settings.get(GITHUB_APP_ID), this.app.hasPrivateKey()]);
        return { appId: appId ?? null, keyInstalled };
    }

    /** Refuses anything but digits, which is all an app id is. Whether GitHub knows it shows on first use. */
    async set({ appId }: SetGitHubAppSettingRequest): Promise<GitHubAppSetting> {
        if (appId !== null && !/^\d+$/.test(appId)) {
            throw httpError(400).withDetails({ reason: `a GitHub App id is a number, got "${appId}"` });
        }
        await this.settings.set(GITHUB_APP_ID, appId ?? undefined);
        return this.get();
    }
}
