import type { LearningsDocument, LearningsVersion, LearningsVersionsQuery, SetLearningsRequest } from './types/learnings.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [learnings.ck](file://./../../../apps/api/data/contracts/learnings.ck)
 */
export class LearningsClient {
    constructor(private fetch: SdkFetch) {}

    /** @name Get learnings */
    async getLearnings(): Promise<LearningsDocument> {
        const result = await this.fetch(`/api/learnings`, { method: 'GET' });
        return await parseJson<LearningsDocument>(result);
    }

    /**
     * @name Set learnings
     * @description `put`, not `patch`: the document is replaced whole. Every save is a new row; the previous
     * document is still there in the history, so a bad edit is undone by saving the earlier text
     * again, never by deleting anything. An empty `markdown` is a valid save.
     */
    async setLearnings(body: SetLearningsRequest): Promise<LearningsDocument> {
        const result = await this.fetch(`/api/learnings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<LearningsDocument>(result);
    }

    /** @name List learnings versions */
    async listLearningsVersions(query?: LearningsVersionsQuery): Promise<LearningsVersion[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/learnings/versions${qs}`, {
            method: 'GET',
        });
        return await parseJson<LearningsVersion[]>(result);
    }
}
