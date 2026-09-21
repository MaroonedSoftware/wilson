// @vitest-environment jsdom
//
// Card 0266. `DiffPane.tsx` gains an interactive comment flow beside card 0265's read-only diff:
// clicking a commentable line opens a composer, an added comment queues in local state, and a
// batch submit posts every pending comment in one call to `POST /api/cards/{id}/findings`
// (`BoardClient.recordFindings`, `useRecordFindings` in `lib/mutations.ts`). None of this exists on
// the pre-change tree — a diff line has no click handler, there is no composer or pending-comments
// panel, and `BoardClient` has no `recordFindings` to spy on — so every assertion below fails there.
// Follows the same "render the real route tree with the SDK mocked" approach
// `card-detail.diff.test.ts` already uses for this same pane.
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
    stages: ['planning', 'implementing', 'testing', 'ready'],
    nonStages: ['parking-lot', 'merged'],
};

const card = (overrides: Partial<CardDetail> = {}): CardDetail => ({
    id: '0007',
    title: 'Do the thing',
    stage: 'ready',
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: 'the plan',
    ...overrides,
});

/** One file, one hunk, with a context line, a removed line and an added line — the added line
 * (`new line`, `newLine: 2`) is what every test below clicks to open a composer. */
const diffWithOneAddedLine = (): CardDiff => ({
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
});

/** Same stand-in `card-detail.diff.test.ts` uses: the root layout's `useCardFeed` needs an `EventSource`. */
class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

/** Same stand-in `card-detail.diff.test.ts` uses: Mantine's `ScrollArea` measures itself via `ResizeObserver`. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
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

async function openDiffTab() {
    await screen.findByText('Do the thing');
    await act(async () => {
        fireEvent.click(await screen.findByRole('tab', { name: 'Diff' }));
    });
}

/** Clicks the added line (`new line`), fills in the composer, and clicks "Add comment" — leaving
 * exactly one pending comment queued, not yet submitted. */
async function addOneComment() {
    await act(async () => {
        fireEvent.click(await screen.findByText('new line'));
    });
    fireEvent.change(screen.getByPlaceholderText("What's wrong?"), { target: { value: 'This is broken' } });
    fireEvent.change(screen.getByPlaceholderText('What would fix it?'), { target: { value: 'Fix it like this' } });
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    });
}

describe('recording line comments on the Diff tab (card 0266)', () => {
    it('opens a composer on a commentable line and queues the comment as pending, without submitting anything (AC6)', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diffWithOneAddedLine());
        const recordFindings = vi.spyOn(BoardClient.prototype, 'recordFindings');

        renderApp(CARD_PATH);
        await openDiffTab();
        await addOneComment();

        expect(await screen.findByText('Pending comments (1)')).toBeTruthy();
        expect(screen.getByText('src/foo.ts:2')).toBeTruthy();
        expect(screen.getByText('This is broken')).toBeTruthy();
        expect(screen.getByText('Fix it like this')).toBeTruthy();
        expect(screen.getByText('blocker')).toBeTruthy();
        expect(recordFindings).not.toHaveBeenCalled();
    });

    it('does not open a composer for a removed line, which has nothing left in the new file to cite', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diffWithOneAddedLine());

        renderApp(CARD_PATH);
        await openDiffTab();
        await screen.findByText('old line');

        await act(async () => {
            fireEvent.click(screen.getByText('old line'));
        });

        expect(screen.queryByPlaceholderText("What's wrong?")).toBeNull();
    });

    it('submits every pending comment in one request, carrying file/line/severity/problem/suggestion, and clears them on success (AC6, AC7)', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValueOnce(card()).mockResolvedValue(card({ stage: 'implementing' }));
        vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diffWithOneAddedLine());
        const recordFindings = vi.spyOn(BoardClient.prototype, 'recordFindings').mockResolvedValue(card({ stage: 'implementing' }));

        renderApp(CARD_PATH);
        await openDiffTab();
        await addOneComment();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Submit 1 comment' }));
        });

        expect(recordFindings).toHaveBeenCalledWith('0007', {
            findings: [{ file: 'src/foo.ts', line: 2, severity: 'blocker', problem: 'This is broken', suggestion: 'Fix it like this' }],
        });
        // The pending list is cleared once the submit lands — nothing left waiting to resend.
        expect(screen.queryByText('Pending comments (1)')).toBeNull();
        // AC7: the card's own query was invalidated, so a refetch shows the card in its new stage
        // without a reload, rather than the page still reading "ready".
        expect(await screen.findByText('implementing', { selector: '.mantine-Badge-label' })).toBeTruthy();
    });

    it("keeps a pending comment and shows the API's refusal reason when the submit fails, rather than losing it (AC6)", async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diffWithOneAddedLine());
        vi.spyOn(BoardClient.prototype, 'recordFindings').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'cannot record findings on 0007: no comments were submitted' } },
                new Headers(),
            ),
        );

        renderApp(CARD_PATH);
        await openDiffTab();
        await addOneComment();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Submit 1 comment' }));
        });

        expect(await screen.findByText('cannot record findings on 0007: no comments were submitted')).toBeTruthy();
        // The pending comment survived the failed submit — nothing was lost to a toast.
        expect(screen.getByText('Pending comments (1)')).toBeTruthy();
        expect(screen.getByText('src/foo.ts:2')).toBeTruthy();
    });

    it('lets a pending comment be removed before it is ever submitted', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diffWithOneAddedLine());
        const recordFindings = vi.spyOn(BoardClient.prototype, 'recordFindings');

        renderApp(CARD_PATH);
        await openDiffTab();
        await addOneComment();
        await screen.findByText('Pending comments (1)');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        });

        expect(screen.queryByText('Pending comments (1)')).toBeNull();
        expect(recordFindings).not.toHaveBeenCalled();
    });
});
