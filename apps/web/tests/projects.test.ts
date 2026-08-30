// Card 0154: `listRegisteredProjects` (`apps/web/src/lib/projects.ts`) is new — a hand-written
// `fetch` against `GET /api/projects`, for the reason its own doc comment gives (there is no `.ck`
// contract a cross-project listing belongs to). These tests drive it through the real fetch
// pipeline, stubbing only the global `fetch` it ultimately calls — the same approach `sdk.test.ts`
// takes for `wilsonForProject` — rather than mocking the function itself.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE } from '#src/lib/sdk.js';
import { listRegisteredProjects } from '#src/lib/projects.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('listRegisteredProjects', () => {
    it('requests GET /api/projects against the configured API base', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);

        await listRegisteredProjects();

        expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/projects`);
    });

    it('resolves to exactly the registered projects the server returns', async () => {
        const projects = [{ name: 'alpha' }, { name: 'beta' }];
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify(projects), { status: 200, headers: { 'content-type': 'application/json' } })),
        );

        await expect(listRegisteredProjects()).resolves.toEqual(projects);
    });

    it('throws, naming the failing status, rather than resolving when the request fails', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500, statusText: 'Internal Server Error' })));

        await expect(listRegisteredProjects()).rejects.toThrow(/500/);
    });
});
