import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverNotDraining } from '#src/checks/server.not.draining.js';

type CheckResult = { ok: boolean; message: string; fixHint?: string };
const run = serverNotDraining.run as unknown as (ctx: unknown) => Promise<CheckResult>;
const ctx = { env: {}, config: { get: (_key: string, fallback: string) => fallback } };

const status = (draining: boolean) =>
    new Response(JSON.stringify({ draining, running: [], held: 3, planDrafts: 0, safeToRestart: draining }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

describe('serverNotDraining', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('passes when the server is not draining', async () => {
        fetchMock.mockResolvedValue(status(false));
        expect((await run(ctx)).ok).toBe(true);
    });

    it('fails with the way out when the server is draining', async () => {
        fetchMock.mockResolvedValue(status(true));
        const result = await run(ctx);
        expect(result).toMatchObject({ ok: false, message: 'draining, with 3 stage(s) held' });
        expect(result.fixHint).toContain('wilson server resume');
    });

    it('passes when the API cannot answer', async () => {
        fetchMock.mockRejectedValue(new TypeError('connection refused'));
        expect((await run(ctx)).ok).toBe(true);
    });
});
