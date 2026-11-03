import type { CodeFilePage, CodeListQuery, CodeListing, CodeReadQuery, CodeSearchQuery, CodeSearchResult } from './types/code.js';
import type { SdkFetch } from './sdk-options.js';
import { parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [code.ck](../../../apps/api/data/contracts/code.ck)
 */
export class CodeClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List project code */
    async listProjectCode(query?: CodeListQuery): Promise<CodeListing> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/code/tree${qs}`, {
            method: 'GET',
        });
        return await parseJson<CodeListing>(result);
    }

    /** @name Read project file */
    async readProjectFile(query?: CodeReadQuery): Promise<CodeFilePage> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/code/file${qs}`, {
            method: 'GET',
        });
        return await parseJson<CodeFilePage>(result);
    }

    /** @name Search project code */
    async searchProjectCode(query?: CodeSearchQuery): Promise<CodeSearchResult> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/code/search${qs}`, {
            method: 'GET',
        });
        return await parseJson<CodeSearchResult>(result);
    }
}
