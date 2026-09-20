// @vitest-environment jsdom
//
// Card 0265. The card page's Diff tab — `DiffPane.tsx`, wired into `CardDetail.tsx` beside
// `MergeControl`, with the lazily-enabled query `ProjectCardDetailRoute` mounts for it — puts a
// card's branch, diffed against its fork point, on the same screen as the plan instead of only
// through `wilson card diff` in a terminal. None of this existed before this card: `BoardClient` has
// no `getCardDiff` to mock on the pre-change tree, and a card outside planning/parking-lot rendered
// its plan directly with no tabs at all — these assertions fail there for both reasons. Follows the
// same "render the real route tree with the SDK mocked" approach `card-detail.actions.test.ts` and
// `criteria-panel.mount.test.ts` already use.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, SdkError } from '@wilson/sdk';
import type { BoardColumns, CardDetail, CardDiff } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const CARD_PATH = '/projects/demo/cards/0007';

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'testing'],
    nonStages: ['parking-lot', 'merged'],
};

const card = (overrides: Partial<CardDetail> = {}): CardDetail => ({
    id: '0007',
    title: 'Do the thing',
    stage: 'testing',
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: 'the plan',
    ...overrides,
});

/** Same stand-in `card-detail.actions.test.ts` uses: the root layout's `useCardFeed` needs an `EventSource`. */
class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

/** Same stand-in `card-detail.actions.test.ts` uses: Mantine's `ScrollArea` measures itself via `ResizeObserver`. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    // `retry: false`: the refusal test below rejects `getCardDiff` and needs the query to settle
    // into its error state within `findByText`'s own timeout rather than TanStack Query's default
    // three retries — the same fix `project-routes.test.ts` applies for its own rejected-query test.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
    vi.spyOn(BoardClient.prototype, 'getCardUsage').mockResolvedValue({ total: { attempts: 0, inputTokens: 0, outputTokens: 0 }, stages: [] });
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

describe('the diff tab', () => {
    it('issues no diff request until the Diff tab is selected (AC6)', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        const getCardDiff = vi.spyOn(BoardClient.prototype, 'getCardDiff');

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await screen.findByText('the plan');

        expect(getCardDiff).not.toHaveBeenCalled();
    });

    it('fetches and renders the diff, with correctly-parsed hunks, once the tab is selected', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        const diff: CardDiff = {
            base: 'abc123',
            truncated: false,
            files: [
                {
                    path: 'src/foo.ts',
                    status: 'modified',
                    truncated: false,
                    patch: '@@ -1,2 +1,2 @@\n context line\n-old line\n+new line\n',
                },
            ],
        };
        const getCardDiff = vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diff);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        await act(async () => {
            fireEvent.click(await screen.findByRole('tab', { name: 'Diff' }));
        });

        expect(getCardDiff).toHaveBeenCalledWith('0007');
        expect(await screen.findByText('src/foo.ts')).toBeTruthy();
        expect(await screen.findByText('modified')).toBeTruthy();
        expect(await screen.findByText('context line')).toBeTruthy();
        expect(await screen.findByText('old line')).toBeTruthy();
        expect(await screen.findByText('new line')).toBeTruthy();
    });

    it('shows a placeholder rather than hunks for a file whose own patch was truncated', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        const diff: CardDiff = {
            base: 'abc123',
            truncated: false,
            files: [{ path: 'package-lock.json', status: 'modified', truncated: true, patch: '' }],
        };
        vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diff);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await act(async () => {
            fireEvent.click(await screen.findByRole('tab', { name: 'Diff' }));
        });

        expect(await screen.findByText("This file's diff is too large to show here.")).toBeTruthy();
        expect(screen.getByText('package-lock.json')).toBeTruthy();
    });

    it('shows a large-diff banner when the response itself was truncated, distinct from a single truncated file', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        const diff: CardDiff = {
            base: 'abc123',
            truncated: true,
            files: [{ path: 'a.ts', status: 'added', truncated: true, patch: '' }],
        };
        vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diff);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await act(async () => {
            fireEvent.click(await screen.findByRole('tab', { name: 'Diff' }));
        });

        expect(await screen.findByText('This diff is large')).toBeTruthy();
    });

    it('shows "No changes." for a branch with an empty diff, distinct from a truncated or errored one', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue({ base: 'abc123', truncated: false, files: [] });

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await act(async () => {
            fireEvent.click(await screen.findByRole('tab', { name: 'Diff' }));
        });

        expect(await screen.findByText('No changes.')).toBeTruthy();
    });

    it("shows the API's refusal reason on the Diff tab without disturbing the rest of the page (AC6)", async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        vi.spyOn(BoardClient.prototype, 'getCardDiff').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'card/0007-do-the-thing has no branch yet' } },
                new Headers(),
            ),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await act(async () => {
            fireEvent.click(await screen.findByRole('tab', { name: 'Diff' }));
        });

        expect(await screen.findByText('card/0007-do-the-thing has no branch yet')).toBeTruthy();
        // The rest of the page survived the failure untouched — the header and stage badge are
        // still there, and the Plan tab's own content is still reachable.
        expect(screen.getByText('testing', { selector: '.mantine-Badge-label' })).toBeTruthy();
        await act(async () => {
            fireEvent.click(await screen.findByRole('tab', { name: 'Plan' }));
        });
        expect(await screen.findByText('the plan')).toBeTruthy();
    });
});
