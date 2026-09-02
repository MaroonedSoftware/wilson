// @vitest-environment jsdom
//
// Card 0189: attaching and reviewing a card's context in the app — `CardContext.tsx`'s section on
// `CardDetail.tsx`, over `lib/mutations.ts`'s `useAttachContext`/`useRemoveContext` (covered in
// isolation by `mutations.test.ts`). This file exercises the same real-app-render approach
// `card-detail.actions.test.ts` takes: the SDK's calls mocked, the route tree rendered for real, so
// the "no optimistic rendering" rule and the refusal-surfacing are exercised as actually wired up,
// not asserted against a hook in isolation.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, ContextClient, SdkError } from '@wilson/sdk';
import type { BoardColumns, CardDetail, ContextSnapshot } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const CARD_PATH = '/projects/demo/cards/0007';

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'testing'],
    nonStages: ['parking-lot', 'merged'],
};

const card: CardDetail = {
    id: '0007',
    title: 'Do the thing',
    stage: 'testing',
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: 'the plan',
};

const snapshot = (overrides: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
    id: 'ctx-1',
    sourceUrl: 'https://example.com/spec',
    fetchedAt: '2026-09-01T12:00:00.000Z',
    fetchedBy: 'human',
    content: 'the fetched body',
    contentHash: 'abc123',
    createdAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
});

// Same jsdom gaps `card-detail.actions.test.ts` stubs — the root layout and app shell pull these
// in regardless of what this file's own tests are about.
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

function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    const queryClient = new QueryClient();
    render(
        createElement(
            MantineProvider,
            null,
            createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
        ),
    );
    return { router };
}

beforeEach(() => {
    vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card);
    vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Element.prototype.scrollIntoView = vi.fn();
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
    Object.defineProperty(document, 'fonts', {
        value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        configurable: true,
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    notifications.clean();
});

describe('the context section', () => {
    it('renders a snapshot with its manifest — source URL, fetched-at and fetched-by', async () => {
        vi.spyOn(ContextClient.prototype, 'listCardContext').mockResolvedValue([snapshot()]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('https://example.com/spec')).toBeTruthy();
        expect(screen.getByText(/Fetched .* by human/)).toBeTruthy();
    });

    it('shows an explained empty state for a card with no snapshots, not a blank space', async () => {
        vi.spyOn(ContextClient.prototype, 'listCardContext').mockResolvedValue([]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('Nothing attached.')).toBeTruthy();
    });

    it('attaches a URL and adds it to the list without a reload, proving the invalidation predicate matches', async () => {
        const listCardContext = vi.spyOn(ContextClient.prototype, 'listCardContext').mockResolvedValue([]);
        let resolveAttach: ((s: ContextSnapshot) => void) | undefined;
        const attachContextToACard = vi.spyOn(ContextClient.prototype, 'attachContextToACard').mockImplementation(
            () =>
                new Promise<ContextSnapshot>(resolve => {
                    resolveAttach = resolve;
                }),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        expect(await screen.findByText('Nothing attached.')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Attach context' }));
        const input = (await screen.findByLabelText('Source URL')) as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'https://example.com/spec' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
        });

        expect(attachContextToACard).toHaveBeenCalledWith('0007', { sourceUrl: 'https://example.com/spec' });
        // In flight: no optimistic insertion — the empty state is still up, and the modal is still open.
        expect(screen.getByText('Nothing attached.')).toBeTruthy();
        expect(screen.getByLabelText('Source URL')).toBeTruthy();

        // The server answers; only the re-fetch this triggers should populate the list.
        listCardContext.mockResolvedValue([snapshot()]);
        await act(async () => {
            resolveAttach?.(snapshot());
        });

        expect(await screen.findByText('https://example.com/spec')).toBeTruthy();
        // The modal closed on success.
        await waitFor(() => expect(screen.queryByLabelText('Source URL')).toBeNull());
        expect(screen.queryByText('Nothing attached.')).toBeNull();
    });

    it("shows the server's own refusal reason and leaves the typed URL in place, adding nothing to the list", async () => {
        vi.spyOn(ContextClient.prototype, 'listCardContext').mockResolvedValue([]);
        vi.spyOn(ContextClient.prototype, 'attachContextToACard').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'refused to fetch a private address' } }, new Headers()),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        fireEvent.click(screen.getByRole('button', { name: 'Attach context' }));
        const input = (await screen.findByLabelText('Source URL')) as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'http://169.254.169.254/' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
        });

        expect(await screen.findByText('refused to fetch a private address')).toBeTruthy();
        // The modal stayed open with what was typed still there to fix and resend.
        expect((screen.getByLabelText('Source URL') as HTMLInputElement).value).toBe('http://169.254.169.254/');
        // Nothing was added to the list.
        expect(screen.getByText('Nothing attached.')).toBeTruthy();
    });

    it('removes a snapshot only after a confirmation, and only the one removed', async () => {
        const other = snapshot({ id: 'ctx-2', sourceUrl: 'https://example.com/other', title: 'Other doc' });
        const listCardContext = vi.spyOn(ContextClient.prototype, 'listCardContext').mockResolvedValue([snapshot(), other]);
        let resolveRemove: (() => void) | undefined;
        const removeAContextSnapshot = vi.spyOn(ContextClient.prototype, 'removeAContextSnapshot').mockImplementation(
            () =>
                new Promise<void>(resolve => {
                    resolveRemove = resolve;
                }),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await screen.findByText('https://example.com/spec');

        const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
        expect(removeButtons).toHaveLength(2);
        fireEvent.click(removeButtons[0]);

        // The confirmation dialog itself — clicking it must not have removed anything yet. The
        // dialog names the same URL again (in its own confirmation copy), so the list's own copy
        // is asserted on scoped away from it.
        const dialog = await screen.findByRole('dialog', { name: 'Remove this snapshot?' });
        expect(removeAContextSnapshot).not.toHaveBeenCalled();
        expect(within(dialog).getByText('https://example.com/spec')).toBeTruthy();
        expect(screen.getAllByText('https://example.com/spec')).toHaveLength(2);

        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
        });

        expect(removeAContextSnapshot).toHaveBeenCalledWith('0007', 'ctx-1');
        // Still in flight — no optimistic removal. Two copies remain (the list item plus the
        // still-open dialog's own confirmation text) until the request resolves.
        expect(screen.getAllByText('https://example.com/spec')).toHaveLength(2);

        listCardContext.mockResolvedValue([other]);
        await act(async () => {
            resolveRemove?.();
        });

        await waitFor(() => expect(screen.queryByText('https://example.com/spec')).toBeNull());
        // The other snapshot survives — only the confirmed one was removed.
        expect(screen.getByText('Other doc')).toBeTruthy();
    });
});
