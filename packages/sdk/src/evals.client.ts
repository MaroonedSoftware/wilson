import type { CaptureEvalFixtureRequest, EvalFixture } from './types/evals.js';
import { reviveEvalFixture } from './types/evals.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [evals.ck](../../../apps/api/data/contracts/evals.ck)
 */
export class EvalsClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List eval fixtures */
    async listEvalFixtures(): Promise<EvalFixture[]> {
        const result = await this.fetch(`/api/evals/fixtures`, { method: 'GET' });
        return (await parseJson<EvalFixture[]>(result)).map(reviveEvalFixture);
    }

    /** @name Capture eval fixture */
    async captureEvalFixture(body: CaptureEvalFixtureRequest): Promise<EvalFixture> {
        const result = await this.fetch(`/api/evals/fixtures`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveEvalFixture(await parseJson<EvalFixture>(result));
    }

    /** @name Remove eval fixture */
    async removeEvalFixture(id: string): Promise<void> {
        await this.fetch(`/api/evals/fixtures/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
}
