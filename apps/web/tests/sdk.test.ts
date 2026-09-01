// Card 0153: `wilsonForProject` is new — a client scoped to one project, sent as
// `X-Wilson-Project` on every call (`SdkOptions.project`, card 0150's mechanism). These tests drive
// it through the real fetch pipeline (`createSdkFetch`, `packages/sdk`), stubbing only the global
// `fetch` the SDK ultimately calls, so what's asserted is the actual header a request carries —
// not a mock standing in for the behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Health } from '@wilson/sdk';
import { API_BASE, wilson, wilsonForProject } from '#src/lib/sdk.js';

const health: Health = {
    ok: true,
    project: 'wilson',
    head: 'abc1234',
    startedAt: '2026-01-01T00:00:00.000Z',
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify(health), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('wilsonForProject', () => {
    it('sends X-Wilson-Project naming the given project on every request the built client makes', async () => {
        const client = wilsonForProject('other-project');

        await client.health.getHealth();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${API_BASE}/api/health`);
        expect((init.headers as Record<string, string>)['X-Wilson-Project']).toBe('other-project');
    });

    it('builds a fresh client per call rather than one shared client mutated in place, so two projects never share a header', async () => {
        await wilsonForProject('project-a').health.getHealth();
        await wilsonForProject('project-b').health.getHealth();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
        const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect((firstInit.headers as Record<string, string>)['X-Wilson-Project']).toBe('project-a');
        expect((secondInit.headers as Record<string, string>)['X-Wilson-Project']).toBe('project-b');
    });

    it('sends no X-Wilson-Project header at all through the app-wide singleton, exactly as before this card', async () => {
        await wilson.health.getHealth();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)['X-Wilson-Project']).toBeUndefined();
    });
});
