// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { DrainStatus } from '@wilson/sdk';
import { DrainControl } from '../src/components/DrainControl.js';
import { DrainIndicator } from '../src/components/DrainIndicator.js';
import { wilson } from '../src/lib/sdk.js';
import { WilsonSdkProvider } from '../src/lib/sdk-context.js';

const status = (overrides: Partial<DrainStatus> = {}): DrainStatus => ({
    draining: false,
    running: [],
    held: 0,
    planDrafts: 0,
    safeToRestart: false,
    ...overrides,
});

const renderWithin = (component: () => unknown) => {
    const router = createRouter({
        routeTree: createRootRoute({ component: component as () => never }),
        history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        createElement(
            MantineProvider,
            null,
            createElement(
                QueryClientProvider,
                { client },
                createElement(WilsonSdkProvider, { client: wilson, children: createElement(RouterProvider, { router: router as never }) }),
            ),
        ),
    );
};

beforeEach(() => {
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    );
    vi.stubGlobal('scrollTo', vi.fn());
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('DrainControl', () => {
    it('reports what is running and that a restart is not safe yet', async () => {
        vi.spyOn(wilson.settings, 'getDrainStatus').mockResolvedValue(
            status({ draining: true, running: [{ project: 'demo', cardId: '0001' }], held: 2 }),
        );

        renderWithin(DrainControl);

        expect(await screen.findByText(/Not safe to restart yet\. 1 running \(demo\/0001\), 2 held, 0 plan drafts\./)).toBeTruthy();
    });

    it('says when a restart is safe', async () => {
        vi.spyOn(wilson.settings, 'getDrainStatus').mockResolvedValue(status({ draining: true, safeToRestart: true }));

        renderWithin(DrainControl);

        expect(await screen.findByText(/^Safe to restart\./)).toBeTruthy();
    });

    it('turns the drain on and shows what the server handed back', async () => {
        vi.spyOn(wilson.settings, 'getDrainStatus').mockResolvedValue(status());
        const setDrain = vi.spyOn(wilson.settings, 'setDrain').mockResolvedValue(status({ draining: true, held: 1 }));

        renderWithin(DrainControl);
        fireEvent.click(await screen.findByLabelText(/^Drain/));

        await waitFor(() => expect(setDrain).toHaveBeenCalledWith({ draining: true }));
        expect(await screen.findByText(/1 held/)).toBeTruthy();
    });

    it('shows a refused write rather than applying it', async () => {
        vi.spyOn(wilson.settings, 'getDrainStatus').mockResolvedValue(status());
        vi.spyOn(wilson.settings, 'setDrain').mockRejectedValue(
            new SdkError(403, 'Forbidden', { statusCode: 403, message: 'not allowed' }, new Headers()),
        );

        renderWithin(DrainControl);
        fireEvent.click(await screen.findByLabelText(/^Drain/));

        expect(await screen.findByText('not allowed')).toBeTruthy();
        expect((screen.getByLabelText(/^Drain/) as HTMLInputElement).checked).toBe(false);
    });
});

describe('DrainIndicator', () => {
    it('shows nothing when the server is not draining', async () => {
        const read = vi.spyOn(wilson.settings, 'getDrainStatus').mockResolvedValue(status());

        renderWithin(DrainIndicator);

        await waitFor(() => expect(read).toHaveBeenCalled());
        expect(screen.queryByText('Draining')).toBeNull();
    });

    it('shows that the server is draining', async () => {
        vi.spyOn(wilson.settings, 'getDrainStatus').mockResolvedValue(status({ draining: true, running: [{ project: 'demo', cardId: '0001' }] }));

        renderWithin(DrainIndicator);

        expect(await screen.findByText('Draining')).toBeTruthy();
    });

    it('shows when a restart is safe', async () => {
        vi.spyOn(wilson.settings, 'getDrainStatus').mockResolvedValue(status({ draining: true, safeToRestart: true }));

        renderWithin(DrainIndicator);

        expect(await screen.findByText('Safe to restart')).toBeTruthy();
    });

    it('shows nothing when the status cannot be read', async () => {
        const read = vi.spyOn(wilson.settings, 'getDrainStatus').mockRejectedValue(new Error('forbidden'));

        renderWithin(DrainIndicator);

        await waitFor(() => expect(read).toHaveBeenCalled());
        expect(screen.queryByText('Draining')).toBeNull();
    });
});
