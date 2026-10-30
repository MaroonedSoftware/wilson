import { DateTime } from 'luxon';
// @vitest-environment jsdom
//
// The dashboard's "New project" control (`apps/web/src/components/NewProjectControl.tsx`): the UI's
// way to do `wilson project create` and `wilson board init` in one go. These render the real route
// tree at `/`, the same approach `dashboard.test.ts` takes. The two writes go through a stubbed
// `fetch` rather than a `ProjectsClient`/`BoardClient` spy, because that is the only place the
// `X-Wilson-Project` header on the init call can be observed (`sdk-context.test.ts` does the same).
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s include, so JSX is
// written via `createElement`.
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, HealthClient, ProjectsClient, SdkError } from '@wilson/sdk';
import type { BoardColumns, DirectoryListing, DirectoryQuery, Health } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';
import { API_BASE } from '#src/lib/sdk.js';

const columns: BoardColumns = { stages: ['implementing'], nonStages: ['merged'] };

const baseHealth: Health = {
    ok: true,
    project: 'demo',
    head: 'abc1234',
    startedAt: DateTime.fromISO('2026-01-01T00:00:00.000Z'),
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const REGISTER_URL = `${API_BASE}/api/projects`;
const INIT_URL = `${API_BASE}/api/board/init`;

let fetchMock: ReturnType<typeof vi.fn>;

const callsTo = (url: string) => fetchMock.mock.calls.filter(([called]: [string]) => called === url) as [string, RequestInit][];

function renderApp() {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/projects'] }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))));
    return { router };
}

async function openForm() {
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    await screen.findByText('Add a project');
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });

beforeEach(() => {
    vi.spyOn(HealthClient.prototype, 'getHealth').mockResolvedValue(baseHealth);
    vi.spyOn(ProjectsClient.prototype, 'listProjects').mockResolvedValue([{ name: 'demo' }]);
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
    vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    );
    vi.stubGlobal('scrollTo', vi.fn());
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the dashboard\'s New project control', () => {
    it('proposes per-project worktree and run roots beside the code root, until a field is edited by hand', async () => {
        renderApp();
        await openForm();

        type('Name', 'myapp');
        type('Code root', '/srv/projects/myapp/');
        expect(field('Worktree root').value).toBe('/srv/projects/.worktrees/myapp');
        expect(field('Run root').value).toBe('/srv/projects/.run/myapp');

        type('Run root', '/var/run/myapp');
        type('Code root', '/elsewhere/myapp');
        expect(field('Worktree root').value).toBe('/elsewhere/.worktrees/myapp');
        expect(field('Run root').value).toBe('/var/run/myapp');
    });

    it('offers no repository without a GitHub App', async () => {
        vi.spyOn(ProjectsClient.prototype, 'listRepositories').mockResolvedValue({ configured: false, repositories: [] });
        renderApp();
        await openForm();

        await waitFor(() => expect(ProjectsClient.prototype.listRepositories).toHaveBeenCalled());
        expect(screen.queryAllByLabelText('Repository')).toEqual([]);
        expect(field('Code root')).toBeTruthy();
    });

    it('registers from a picked repository alone, naming the project after it', async () => {
        vi.spyOn(ProjectsClient.prototype, 'listRepositories').mockResolvedValue({
            configured: true,
            repositories: [{ fullName: 'acme/toku-ats', private: true, defaultBranch: 'main' }],
        });
        fetchMock.mockImplementation(async (url: string) => (url === REGISTER_URL ? json(201, { name: 'toku-ats' }) : json(200, { stages: [] })));
        renderApp();
        await openForm();

        fireEvent.click((await screen.findAllByLabelText('Repository'))[0]!);
        fireEvent.click(await screen.findByRole('option', { name: 'acme/toku-ats', hidden: true }));

        await waitFor(() => expect(field('Name').value).toBe('toku-ats'));
        expect(screen.queryByLabelText('Code root')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(callsTo(REGISTER_URL)).toHaveLength(1));
        expect(JSON.parse(callsTo(REGISTER_URL)[0]![1].body as string)).toEqual({ name: 'toku-ats', repository: 'acme/toku-ats' });
    });

    it('keeps Create disabled until every field has a value', async () => {
        renderApp();
        await openForm();

        const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
        expect(create.disabled).toBe(true);

        type('Name', 'myapp');
        expect(create.disabled).toBe(true);

        type('Code root', '/srv/projects/myapp');
        expect(create.disabled).toBe(false);
    });

    it('registers the project, initialises its board under its own X-Wilson-Project, then opens that board', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTER_URL) return json(200, { name: 'myapp' });
            if (url === INIT_URL) return json(200, columns);
            throw new Error(`unexpected fetch to ${url}`);
        });
        const { router } = renderApp();
        await openForm();

        type('Name', 'myapp');
        type('Code root', '/srv/projects/myapp');
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(router.state.location.pathname).toBe('/projects/myapp'));

        const [register] = callsTo(REGISTER_URL);
        expect(register?.[1].method).toBe('POST');
        expect(JSON.parse(register?.[1].body as string)).toEqual({
            name: 'myapp',
            codeRoot: '/srv/projects/myapp',
            worktreeRoot: '/srv/projects/.worktrees/myapp',
            runRoot: '/srv/projects/.run/myapp',
        });

        const [init] = callsTo(INIT_URL);
        expect(init?.[1].method).toBe('POST');
        expect((init?.[1].headers as Record<string, string>)['X-Wilson-Project']).toBe('myapp');
    });

    it('shows the API\'s refusal inline and keeps the form as typed when registering fails', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTER_URL) return json(409, { message: 'Conflict', details: { reason: 'project "myapp" is already registered' } });
            throw new Error(`unexpected fetch to ${url}`);
        });
        const { router } = renderApp();
        await openForm();

        type('Name', 'myapp');
        type('Code root', '/srv/projects/myapp');
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));

        expect(await screen.findByText('Could not register the project')).toBeTruthy();
        expect(screen.getByText('project "myapp" is already registered')).toBeTruthy();
        expect(field('Name').value).toBe('myapp');
        expect(callsTo(INIT_URL)).toHaveLength(0);
        expect(router.state.location.pathname).toBe('/projects');
    });

    it('retries only the board init after registering succeeded and initialising failed', async () => {
        let initAttempts = 0;
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTER_URL) return json(200, { name: 'myapp' });
            if (url === INIT_URL) {
                initAttempts += 1;
                return initAttempts === 1 ? json(500, { message: 'Internal Server Error' }) : json(200, columns);
            }
            throw new Error(`unexpected fetch to ${url}`);
        });
        const { router } = renderApp();
        await openForm();

        type('Name', 'myapp');
        type('Code root', '/srv/projects/myapp');
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));

        expect(await screen.findByText('Registered, but could not initialise its board')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(router.state.location.pathname).toBe('/projects/myapp'));
        expect(callsTo(REGISTER_URL)).toHaveLength(1);
        expect(callsTo(INIT_URL)).toHaveLength(2);
    });
});

/**
 * The folder picker behind each path field's Browse button. `listDirectories` is answered from this
 * fake tree, rooted at `/home/me` the way the API confines itself to the home folder; anything not
 * in it is a 404, as the API answers for a missing path.
 */
describe('the path fields\' folder picker', () => {
    const HOME = '/home/me';
    const tree: Record<string, string[]> = {
        [HOME]: ['.config', 'projects'],
        [`${HOME}/projects`]: ['myapp', 'other'],
        [`${HOME}/projects/myapp`]: ['src'],
        [`${HOME}/projects/other`]: [],
    };

    let listDirectories: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        listDirectories = vi.spyOn(ProjectsClient.prototype, 'listDirectories').mockImplementation(async (query?: DirectoryQuery) => {
            const path = query?.path ?? HOME;
            const directories = tree[path];
            if (!directories) throw new SdkError(404, 'Not Found', { details: { reason: `nothing exists at "${path}"` } }, new Headers());
            const listing: DirectoryListing = { path, directories };
            if (path !== HOME) listing.parent = path.slice(0, path.lastIndexOf('/'));
            return listing;
        });
    });

    const openPicker = async (label: string) => {
        fireEvent.click(screen.getByRole('button', { name: `Browse for ${label}` }));
        await screen.findByText(`Choose ${label}`);
    };

    const folder = (name: string) => screen.findByRole('button', { name });

    it('browses from the home folder into a repo and fills the code root with it, naming the project after it', async () => {
        renderApp();
        await openForm();
        await openPicker('code root');

        expect(listDirectories).toHaveBeenCalledWith({});
        fireEvent.click(await folder('projects'));
        fireEvent.click(await folder('myapp'));
        await screen.findByRole('button', { name: 'src' });
        fireEvent.click(screen.getByRole('button', { name: 'Select this folder' }));

        await waitFor(() => expect(field('Code root').value).toBe(`${HOME}/projects/myapp`));
        expect(field('Name').value).toBe('myapp');
        expect(field('Worktree root').value).toBe(`${HOME}/projects/.worktrees/myapp`);
    });

    it('leaves a name already typed alone when a code root is picked', async () => {
        renderApp();
        await openForm();
        type('Name', 'renamed');
        type('Code root', `${HOME}/projects/myapp`);
        await openPicker('code root');

        fireEvent.click(screen.getByRole('button', { name: 'Up one folder' }));
        await folder('other');
        fireEvent.click(await folder('other'));
        await screen.findByText('No folders here.');
        fireEvent.click(screen.getByRole('button', { name: 'Select this folder' }));

        await waitFor(() => expect(field('Code root').value).toBe(`${HOME}/projects/other`));
        expect(field('Name').value).toBe('renamed');
    });

    it('opens a proposed worktree root that does not exist yet at its nearest existing parent', async () => {
        renderApp();
        await openForm();
        type('Name', 'myapp');
        type('Code root', `${HOME}/projects/myapp`);
        await openPicker('worktree root');

        expect(await screen.findByText(`${HOME}/projects`)).toBeTruthy();
        expect(listDirectories).toHaveBeenCalledWith({ path: `${HOME}/projects/.worktrees/myapp` });
        expect(listDirectories).toHaveBeenCalledWith({ path: `${HOME}/projects/.worktrees` });
        expect(listDirectories).toHaveBeenCalledWith({ path: `${HOME}/projects` });
    });

    it('hides dotfolders until asked, and cannot go up from the home folder', async () => {
        renderApp();
        await openForm();
        await openPicker('code root');

        await folder('projects');
        expect(screen.queryByRole('button', { name: '.config' })).toBeNull();
        expect((screen.getByRole('button', { name: 'Up one folder' }) as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(screen.getByLabelText('Show hidden folders'));
        expect(await folder('.config')).toBeTruthy();
    });
});
