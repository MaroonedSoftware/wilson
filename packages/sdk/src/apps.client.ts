import type { App, AppSummary, InstallAppRequest } from './types/apps.js';
import { reviveApp, reviveAppSummary } from './types/apps.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [apps.ck](../../../apps/api/data/contracts/apps.ck)
 */
export class AppsClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List apps */
    async listApps(): Promise<AppSummary[]> {
        const result = await this.fetch(`/api/apps`, { method: 'GET' });
        return (await parseJson<AppSummary[]>(result)).map(reviveAppSummary);
    }

    /** @name Get an app */
    async getApp(slug: string): Promise<App> {
        const result = await this.fetch(`/api/apps/${encodeURIComponent(slug)}`, { method: 'GET' });
        return reviveApp(await parseJson<App>(result));
    }

    /**
     * @name Install an app
     * @description Install an app under this slug, or replace the one already there. `createdAt` survives a replace.
     */
    async installApp(slug: string, body: InstallAppRequest): Promise<App> {
        const result = await this.fetch(`/api/apps/${encodeURIComponent(slug)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveApp(await parseJson<App>(result));
    }

    /** @name Remove an app */
    async removeApp(slug: string): Promise<void> {
        await this.fetch(`/api/apps/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    }
}
