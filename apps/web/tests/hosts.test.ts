// @vitest-environment jsdom
//
// The hosts page: the real route tree rendered with `wilson`'s SDK calls mocked, the way
// `settings.test.ts` renders `/settings`. Files are `.test.ts` and JSX is `createElement`, for the
// reason that file gives.
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { Host } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { relativeTime } from '#src/routes/hosts.js';
import { routeTree } from '#src/routeTree.gen.js';

class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    render(
        createElement(
            MantineProvider,
            null,
            createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router })),
        ),
    );
    return { router };
}

/** Mantine's `Select` (the serve-a-project form) measures itself with this; jsdom has none. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const NOW = Date.parse('2026-10-29T12:00:00Z');

const agentHost: Host = {
    name: 'agent-3',
    sshTarget: 'agent-3',
    slots: 2,
    enabled: true,
    draining: false,
    lifetimeMinutes: 720,
    commandEnv: ['GITHUB_TOKEN'],
    projects: [{ project: 'tga', codeRoot: '/opt/agent/TGA', worktreeRoot: '/opt/agent/wt', runRoot: '/opt/agent/run' }],
    running: [{ slot: 1, project: 'tga', cardId: '0042', since: '2026-10-29T11:40:00Z' }],
    probe: { probedAt: '2026-10-29T11:55:00Z', ok: true, engineVersion: '2.1.280', expiresAt: '2026-10-29T20:00:00Z' },
};

beforeEach(() => {
    vi.spyOn(wilson.board, 'listBoardColumns').mockResolvedValue({ stages: [], nonStages: [] });
    vi.spyOn(wilson.board, 'listCards').mockResolvedValue([]);
    vi.spyOn(wilson.projects, 'listProjects').mockResolvedValue([{ name: 'tga' }, { name: 'wilson' }]);
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

describe('relativeTime', () => {
    it('says how far ahead or behind a time is, to the minute', () => {
        expect(relativeTime('2026-10-29T20:12:00Z', NOW)).toBe('in 8h 12m');
        expect(relativeTime('2026-10-29T11:55:00Z', NOW)).toBe('5m ago');
        expect(relativeTime('2026-10-29T12:00:20Z', NOW)).toBe('in less than a minute');
    });
});

describe('the hosts page', () => {
    it('is reachable from the header', async () => {
        vi.spyOn(wilson.hosts, 'listHosts').mockResolvedValue([]);
        renderApp('/');

        const link = await screen.findByLabelText('Hosts');
        expect(link.getAttribute('href')).toBe('/hosts');
        fireEvent.click(link);

        expect(await screen.findByText(/No hosts yet/)).toBeTruthy();
    });

    it('shows each host’s state, probe, slots in use with links to their cards, and the projects it serves', async () => {
        vi.spyOn(wilson.hosts, 'listHosts').mockResolvedValue([agentHost]);
        renderApp('/hosts');

        const panel = await screen.findByLabelText('host agent-3');
        expect(within(panel).getByText('enabled')).toBeTruthy();
        expect(within(panel).getByText(/probe ok/)).toBeTruthy();
        expect(within(panel).getByText(/claude 2\.1\.280/)).toBeTruthy();
        expect(within(panel).getByText('1 of 2 slots in use')).toBeTruthy();
        const card = within(panel).getByRole('link', { name: 'tga 0042' });
        expect(card.getAttribute('href')).toBe('/projects/tga/cards/0042');
        expect(within(panel).getByText('/opt/agent/TGA')).toBeTruthy();
    });

    it('shows why a host failed its last probe', async () => {
        vi.spyOn(wilson.hosts, 'listHosts').mockResolvedValue([
            {
                ...agentHost,
                running: [],
                probe: { probedAt: '2026-10-29T11:55:00Z', ok: false, detail: 'cannot reach agent-3: Connection timed out' },
            },
        ]);
        renderApp('/hosts');

        expect(await screen.findByText('Last probe failed')).toBeTruthy();
        expect(screen.getByText('cannot reach agent-3: Connection timed out')).toBeTruthy();
    });

    it('drains a host through the API and re-reads it', async () => {
        const list = vi.spyOn(wilson.hosts, 'listHosts').mockResolvedValue([agentHost]);
        const update = vi.spyOn(wilson.hosts, 'updateHost').mockResolvedValue({ ...agentHost, draining: true });
        renderApp('/hosts');

        fireEvent.click(await screen.findByRole('button', { name: 'Drain' }));

        await waitFor(() => expect(update).toHaveBeenCalledWith('agent-3', { draining: true }));
        await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
    });

    it('asks for a second click before removing a host', async () => {
        vi.spyOn(wilson.hosts, 'listHosts').mockResolvedValue([agentHost]);
        const remove = vi.spyOn(wilson.hosts, 'removeHost').mockResolvedValue(undefined);
        renderApp('/hosts');

        fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
        expect(remove).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));

        await waitFor(() => expect(remove).toHaveBeenCalledWith('agent-3'));
    });

    it('registers a host, sending only the fields filled in, and shows a refusal in the server’s words', async () => {
        vi.spyOn(wilson.hosts, 'listHosts').mockResolvedValue([]);
        const register = vi
            .spyOn(wilson.hosts, 'registerHost')
            .mockRejectedValueOnce(new SdkError(409, 'Conflict', { details: { reason: 'host "agent-4" is already registered' } }, new Headers()))
            .mockResolvedValueOnce({ ...agentHost, name: 'agent-4' });
        renderApp('/hosts');

        fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'agent-4' } });
        fireEvent.click(screen.getByRole('button', { name: 'Register' }));

        await waitFor(() => expect(register).toHaveBeenCalledWith({ name: 'agent-4', slots: 1 }));
        expect(await screen.findByText('host "agent-4" is already registered')).toBeTruthy();
    });
});
