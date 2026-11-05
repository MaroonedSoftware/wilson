// @vitest-environment jsdom
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { App, Health } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { routeTree } from '#src/routeTree.gen.js';

/** An app's page, `/projects/$project/apps/$slug`, and the way there from Settings. */

const NOW = DateTime.fromISO('2026-11-05T00:00:00.000Z');
const burndown: App = {
    slug: 'burndown',
    name: 'Burndown',
    description: '',
    grants: [],
    apiVersion: 1,
    html: '<h1>hello</h1>',
    createdAt: NOW,
    updatedAt: NOW,
};
const health: Health = { ok: true, project: 'wilson', head: 'abc1234', startedAt: NOW, codeRoot: '/code', worktreeRoot: '/worktrees' };

class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const renderAt = (path: string) => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(MantineProvider, null, createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))));
};

beforeEach(() => {
    vi.spyOn(wilson.health, 'getHealth').mockResolvedValue(health);
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

describe('an app page', () => {
    it('runs the app named in the URL', async () => {
        const getApp = vi.spyOn(wilson.apps, 'getApp').mockResolvedValue(burndown);

        renderAt('/projects/wilson/apps/burndown');

        const frame = (await screen.findByTitle('Burndown')) as HTMLIFrameElement;
        expect(getApp).toHaveBeenCalledWith('burndown');
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame.getAttribute('srcdoc')).toContain('<h1>hello</h1>');
    });

    it('does not run an app written for an app API this Wilson does not offer', async () => {
        vi.spyOn(wilson.apps, 'getApp').mockResolvedValue({ ...burndown, apiVersion: 2 });

        renderAt('/projects/wilson/apps/burndown');

        expect(await screen.findByText('Burndown needs a newer Wilson')).toBeTruthy();
        expect(screen.getByText(/version 2 of the app API/)).toBeTruthy();
        expect(screen.queryByTitle('Burndown')).toBeNull();
    });

    it('says so when no such app is installed', async () => {
        vi.spyOn(wilson.apps, 'getApp').mockRejectedValue(new SdkError(404, 'Not Found', {}, new Headers()));

        renderAt('/projects/wilson/apps/nope');

        expect(await screen.findByText('No app "nope"')).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Cannot reach the API' })).toBeNull();
    });
});

describe('the way there from Settings', () => {
    beforeEach(() => {
        vi.spyOn(wilson.apps, 'listApps').mockResolvedValue([burndown]);
    });

    it('offers Open, for the project Settings was reached from', async () => {
        renderAt('/settings?project=wilson');

        const open = (await screen.findByRole('link', { name: 'Open' })) as HTMLAnchorElement;
        expect(open.getAttribute('href')).toBe('/projects/wilson/apps/burndown');
    });

    it('offers no Open when Settings was reached from no project', async () => {
        renderAt('/settings');

        await screen.findByText('Burndown');
        expect(screen.queryByRole('link', { name: 'Open' })).toBeNull();
    });
});

describe('the apps list', () => {
    it('is linked from the header of a project', async () => {
        vi.spyOn(wilson.apps, 'listApps').mockResolvedValue([]);

        renderAt('/projects/wilson/apps');

        const link = (await screen.findByRole('link', { name: 'Apps' })) as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/projects/wilson/apps');
    });

    it('opens each app in this project, without fetching its HTML', async () => {
        const { html: _html, ...summary } = burndown;
        vi.spyOn(wilson.apps, 'listApps').mockResolvedValue([{ ...summary, description: 'Cards left', grants: ['board.read'] }]);
        const getApp = vi.spyOn(wilson.apps, 'getApp');

        renderAt('/projects/wilson/apps');

        const open = (await screen.findByRole('link', { name: 'Burndown' })) as HTMLAnchorElement;
        expect(open.getAttribute('href')).toBe('/projects/wilson/apps/burndown');
        expect(screen.getByText('Cards left')).toBeTruthy();
        expect(screen.getByText('Board')).toBeTruthy();
        expect(getApp).not.toHaveBeenCalled();
    });

    it('says where to install one when there are none', async () => {
        vi.spyOn(wilson.apps, 'listApps').mockResolvedValue([]);

        renderAt('/projects/wilson/apps');

        const empty = await screen.findByText(/No apps installed/);
        expect(within(empty).getByRole('link', { name: 'Settings' }).getAttribute('href')).toContain('/settings?project=wilson');
    });
});
