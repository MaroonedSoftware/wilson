// @vitest-environment jsdom
//
// The Diff tab's review comments: stored on the server, on either side of a diff. Renders the real route
// tree with the SDK mocked, as `card-detail.diff.test.ts` does for this same pane.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, ReviewClient, SdkError } from '@wilson/sdk';
import type { BoardColumns, CardDetail, CardDiff, Review, ReviewComment, ReviewState } from '@wilson/sdk';
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

const review = (overrides: Partial<Review> = {}): Review => ({
    id: '1',
    head: 'sha-1',
    base: 'abc123',
    status: 'open',
    stale: false,
    createdAt: new Date() as never,
    ...overrides,
});

const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({
    id: '10',
    reviewId: '1',
    head: 'sha-1',
    file: 'src/foo.ts',
    side: 'new',
    line: 2,
    lineText: 'new line',
    severity: 'blocker',
    text: 'This is broken',
    status: 'open',
    location: 'found',
    currentLine: 2,
    createdAt: new Date() as never,
    ...overrides,
});

/** Serves `state` from both review reads, the way the server answers once a review exists. */
const serve = (state: ReviewState) => {
    vi.spyOn(ReviewClient.prototype, 'readAReview').mockResolvedValue(state);
    vi.spyOn(ReviewClient.prototype, 'openAReview').mockResolvedValue(state);
};

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
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
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

async function typeComment(lineText: string, text: string) {
    await act(async () => {
        fireEvent.click(await screen.findByText(lineText));
    });
    fireEvent.change(await screen.findByPlaceholderText('What should change here?'), { target: { value: text } });
}

/** The card, the diff and a review, and the Diff tab open. */
async function open(state: ReviewState, overrides: Partial<CardDetail> = {}) {
    vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card(overrides));
    vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diffWithOneAddedLine());
    serve(state);
    renderApp(CARD_PATH);
    await openDiffTab();
    await screen.findByText('new line');
}

describe('review comments on the Diff tab', () => {
    it('saves a comment on an added line straight away, with the commit the person saw', async () => {
        const add = vi.spyOn(ReviewClient.prototype, 'addAReviewComment').mockResolvedValue(comment());
        await open({ review: review(), comments: [] });

        await typeComment('new line', 'This is broken');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
        });

        expect(add).toHaveBeenCalledWith('0007', {
            head: 'sha-1',
            file: 'src/foo.ts',
            side: 'new',
            line: 2,
            severity: 'blocker',
            text: 'This is broken',
        });
    });

    it('comments on a removed line on the old side', async () => {
        const add = vi.spyOn(ReviewClient.prototype, 'addAReviewComment').mockResolvedValue(comment({ side: 'old' }));
        await open({ review: review(), comments: [] });

        await typeComment('old line', 'Why remove this');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
        });

        expect(add).toHaveBeenCalledWith('0007', expect.objectContaining({ side: 'old', line: 2, text: 'Why remove this' }));
    });

    it('shows a stored comment under its line after a reload, with no typing', async () => {
        await open({ review: review(), comments: [comment()] });

        expect(await screen.findByText('This is broken')).toBeTruthy();
        expect(screen.getByText('blocker')).toBeTruthy();
    });

    it('keeps what was typed and shows the reason when saving is refused', async () => {
        vi.spyOn(ReviewClient.prototype, 'addAReviewComment').mockRejectedValue(
            new SdkError(409, 'Conflict', { statusCode: 409, details: { reason: "0007's branch has moved on" } }, new Headers()),
        );
        await open({ review: review(), comments: [] });

        await typeComment('new line', 'Keep me');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
        });

        expect(await screen.findByText("0007's branch has moved on")).toBeTruthy();
        expect(screen.getByDisplayValue('Keep me')).toBeTruthy();
    });

    it('resolves an open comment', async () => {
        const resolve = vi.spyOn(ReviewClient.prototype, 'resolveAReviewComment').mockResolvedValue(comment({ status: 'resolved' }));
        await open({ review: review(), comments: [comment()] });

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
        });

        expect(resolve).toHaveBeenCalledWith('0007', '10');
    });

    it('hides a resolved comment, and lists an outdated one apart with the line it was written on', async () => {
        await open({
            review: review(),
            comments: [
                comment({ id: '11', status: 'resolved', text: 'Dealt with' }),
                comment({ id: '12', location: 'outdated', currentLine: undefined, lineText: 'gone now', text: 'Lost its line' }),
            ],
        });

        expect(await screen.findByText('Outdated comments (1)')).toBeTruthy();
        expect(screen.getByText('src/foo.ts:2 gone now')).toBeTruthy();
        expect(screen.getByText('Lost its line')).toBeTruthy();
        expect(screen.queryByText('Dealt with')).toBeNull();
    });

    it('sends open comments with Request changes, and shows the card in its new stage', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard')
            .mockResolvedValueOnce(card())
            .mockResolvedValue(card({ stage: 'implementing' }));
        vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diffWithOneAddedLine());
        serve({ review: review(), comments: [comment()] });
        const request = vi
            .spyOn(ReviewClient.prototype, 'requestChanges')
            .mockResolvedValue({ review: review({ status: 'changes_requested' }), comments: [comment({ status: 'sent' })] });
        renderApp(CARD_PATH);
        await openDiffTab();

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Request changes' }));
        });

        expect(request).toHaveBeenCalledWith('0007', { head: 'sha-1' });
        expect(await screen.findByText('implementing', { selector: '.mantine-Badge-label' })).toBeTruthy();
    });

    it('offers to review the new commit once the branch has moved, and takes no comments until then', async () => {
        const reopen = vi.fn();
        await open({ review: review({ stale: true }), comments: [] });
        vi.spyOn(ReviewClient.prototype, 'openAReview').mockImplementation(async () => {
            reopen();
            return { review: review({ head: 'sha-2' }), comments: [] };
        });

        await act(async () => {
            fireEvent.click(await screen.findByText('new line'));
        });
        expect(screen.queryByPlaceholderText('What should change here?')).toBeNull();

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Review the new commit' }));
        });
        expect(reopen).toHaveBeenCalled();
    });

    it('is read-only outside ready: comments show, nothing opens a review or a composer', async () => {
        await open({ review: review(), comments: [comment()] }, { stage: 'testing' });

        await screen.findByText('This is broken');
        await act(async () => {
            fireEvent.click(screen.getByText('new line'));
        });

        expect(ReviewClient.prototype.openAReview).not.toHaveBeenCalled();
        expect(screen.queryByPlaceholderText('What should change here?')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
    });

    it('approves at the commit on screen, then shows that commit in place of the button', async () => {
        const approve = vi
            .spyOn(ReviewClient.prototype, 'approveAReview')
            .mockResolvedValue({ review: review({ status: 'approved' }), comments: [] });
        await open({ review: review(), comments: [] });

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
        });

        expect(approve).toHaveBeenCalledWith('0007', { head: 'sha-1' });
        expect(await screen.findByText('Approved at sha-1')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    });

    it("shows the server's reason when an open blocker refuses the approval", async () => {
        vi.spyOn(ReviewClient.prototype, 'approveAReview').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, details: { reason: 'cannot approve 0007: 1 open blocker(s) to resolve or send first' } },
                new Headers(),
            ),
        );
        await open({ review: review(), comments: [comment()] });

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
        });

        expect(await screen.findByText('cannot approve 0007: 1 open blocker(s) to resolve or send first')).toBeTruthy();
    });

    it('warns that an approval was for an older commit once the branch has moved', async () => {
        await open({ review: review({ status: 'approved', stale: true }), comments: [] });

        expect(await screen.findByText(/The approval was for sha-1/)).toBeTruthy();
    });
});
