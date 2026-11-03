// @vitest-environment jsdom
//
// The review workspace on a card in `ready`: the agent's tour and the conversation beside the diff.
// Renders the real route tree with the SDK mocked, as `diff-comments.test.ts` does.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, ReviewClient, SdkError } from '@wilson/sdk';
import type { BoardColumns, CardDetail, CardDiff, Review, ReviewTourStep, ReviewTurn } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const CARD_PATH = '/projects/demo/cards/0007';
const columns: BoardColumns = { stages: ['implementing', 'ready'], nonStages: ['parking-lot', 'merged'] };

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

const diff: CardDiff = {
    base: 'abc123',
    truncated: false,
    files: [{ path: 'src/foo.ts', status: 'modified', truncated: false, patch: '@@ -1,2 +1,2 @@\n context line\n-old line\n+new line\n' }],
};

const review = (overrides: Partial<Review> = {}): Review => ({
    id: '1',
    head: 'sha-1',
    base: 'abc123',
    status: 'open',
    stale: false,
    createdAt: DateTime.now(),
    ...overrides,
});

const TOUR: ReviewTourStep[] = [
    {
        title: 'The new line',
        explanation: 'Why it changed',
        anchors: [
            { file: 'src/foo.ts', side: 'new', startLine: 2, endLine: 2, status: 'in-diff' },
            { file: 'src/bar.ts', side: 'new', startLine: 9, endLine: 12, status: 'outside-diff' },
        ],
    },
    { title: 'The rest', explanation: 'What else to check', anchors: [] },
];

const turn = (seq: number, role: ReviewTurn['role'], content: string): ReviewTurn => ({ seq, role, content, createdAt: DateTime.now() });

/** A stand-in the tests can fire stream events through. */
class FakeEventSource {
    static instances: FakeEventSource[] = [];
    listeners = new Map<string, (event: { data: string }) => void>();
    url: string;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }
    addEventListener(name: string, listener: (event: { data: string }) => void) {
        this.listeners.set(name, listener);
    }
    close() {}
}

const stream = () => FakeEventSource.instances.find(source => source.url.includes('/review/stream'));

class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const scrolled = vi.fn();

beforeEach(() => {
    FakeEventSource.instances = [];
    scrolled.mockClear();
    vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
    vi.spyOn(BoardClient.prototype, 'getCardUsage').mockResolvedValue({ total: { attempts: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, stages: [] });
    vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
    vi.spyOn(BoardClient.prototype, 'getCardDiff').mockResolvedValue(diff);
    vi.spyOn(ReviewClient.prototype, 'listReviewTurns').mockResolvedValue([]);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Element.prototype.scrollIntoView = scrolled;
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
    Object.defineProperty(document, 'fonts', { value: { addEventListener: vi.fn(), removeEventListener: vi.fn() }, configurable: true });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    notifications.clean();
});

const serve = (current: Review) => {
    vi.spyOn(ReviewClient.prototype, 'readAReview').mockResolvedValue({ review: current, comments: [] });
    vi.spyOn(ReviewClient.prototype, 'openAReview').mockResolvedValue({ review: current, comments: [] });
};

async function open() {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [CARD_PATH] }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
    await screen.findByText('Do the thing');
    await act(async () => {
        fireEvent.click(await screen.findByRole('tab', { name: 'Review' }));
    });
    await screen.findByText('new line');
}

describe('the review workspace', () => {
    it('names the tab Diff outside ready, with no agent and no conversation', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card({ stage: 'testing' }));
        vi.spyOn(ReviewClient.prototype, 'readAReview').mockResolvedValue({ comments: [] });
        const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [CARD_PATH] }) });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(
            createElement(
                MantineProvider,
                null,
                createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
            ),
        );

        await act(async () => {
            fireEvent.click(await screen.findByRole('tab', { name: 'Diff' }));
        });
        await screen.findByText('new line');

        expect(screen.queryByRole('button', { name: 'Walk me through this' })).toBeNull();
        expect(screen.queryByLabelText('Message')).toBeNull();
        expect(stream()).toBeUndefined();
    });

    it('opens no stream and asks nothing of the server until the tab is opened', async () => {
        serve(review());
        const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [CARD_PATH] }) });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(
            createElement(
                MantineProvider,
                null,
                createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
            ),
        );

        await screen.findByText('Do the thing');

        expect(stream()).toBeUndefined();
        expect(ReviewClient.prototype.openAReview).not.toHaveBeenCalled();
        expect(ReviewClient.prototype.listReviewTurns).not.toHaveBeenCalled();
    });

    it('names its project on the stream, which cannot set a header', async () => {
        serve(review());
        await open();

        expect(stream()!.url).toContain('?project=demo');
    });

    it('asks for a tour only when the person does, naming the commit on screen', async () => {
        serve(review());
        const send = vi.spyOn(ReviewClient.prototype, 'sendAReviewTurn').mockResolvedValue(turn(2, 'assistant', 'Here you go'));
        await open();
        expect(send).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Walk me through this' }));
        });

        expect(send).toHaveBeenCalledWith('0007', { head: 'sha-1', text: 'Walk me through this change.', mode: 'tour' });
    });

    it('stays ready to retry when a tour turn wrote no tour, and shows why it failed', async () => {
        serve(review());
        vi.spyOn(ReviewClient.prototype, 'sendAReviewTurn').mockRejectedValue(
            new SdkError(
                503,
                'Unavailable',
                { statusCode: 503, details: { reason: 'the review agent could not answer: usage limit' } },
                new Headers(),
            ),
        );
        await open();

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Walk me through this' }));
        });

        expect(await screen.findByText('the review agent could not answer: usage limit')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Walk me through this' })).toBeTruthy();
    });

    it('shows a step, a link to code in the diff, and a plain label for code outside it', async () => {
        serve(review({ tour: TOUR }));
        await open();

        expect(await screen.findByText('The new line')).toBeTruthy();
        expect(screen.getByText('Why it changed')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'src/foo.ts:2' })).toBeTruthy();
        expect(screen.getByText('src/bar.ts:9-12 (unchanged code)')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /src\/bar\.ts/ })).toBeNull();
    });

    it('jumps to the line an anchor names', async () => {
        serve(review({ tour: TOUR }));
        await open();
        scrolled.mockClear();

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'src/foo.ts:2' }));
        });

        expect(scrolled).toHaveBeenCalledTimes(1);
        expect((scrolled.mock.contexts[0] as HTMLElement).textContent).toContain('new line');
    });

    it('moves between steps, jumping to each and marking the lines it is about', async () => {
        serve(review({ tour: TOUR }));
        await open();
        await screen.findByText('The new line');

        const row = screen.getByText('new line').parentElement!;
        expect(row.style.backgroundColor).not.toBe('');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        });

        expect(await screen.findByText('The rest')).toBeTruthy();
        expect(screen.getByText('new line').parentElement!.style.backgroundColor).toBe('');
        expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('sends a message with the step on screen, and clears the box', async () => {
        serve(review({ tour: TOUR }));
        const send = vi.spyOn(ReviewClient.prototype, 'sendAReviewTurn').mockResolvedValue(turn(2, 'assistant', 'Because'));
        await open();

        const box = await screen.findByLabelText('Message');
        fireEvent.change(box, { target: { value: 'why this?' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        });

        expect(send).toHaveBeenCalledWith('0007', { head: 'sha-1', text: 'why this?', stepIndex: 0 });
        expect((box as HTMLTextAreaElement).value).toBe('');
    });

    it('shows the reply as it streams in, then the stored turn', async () => {
        serve(review());
        await open();

        await act(async () => {
            stream()!.listeners.get('delta')!({ data: 'Partly writ' });
        });
        expect(await screen.findByText('Partly writ')).toBeTruthy();

        vi.spyOn(ReviewClient.prototype, 'listReviewTurns').mockResolvedValue([turn(1, 'user', 'hello'), turn(2, 'assistant', 'All written')]);
        await act(async () => {
            stream()!.listeners.get('done')!({ data: '{"seq":2}' });
        });

        expect(await screen.findByText('All written')).toBeTruthy();
        expect(screen.queryByText('Partly writ')).toBeNull();
    });

    it('rereads the review when the agent publishes a tour mid-turn', async () => {
        serve(review());
        await open();
        await screen.findByRole('button', { name: 'Walk me through this' });

        vi.spyOn(ReviewClient.prototype, 'readAReview').mockResolvedValue({ review: review({ tour: TOUR }), comments: [] });
        await act(async () => {
            stream()!.listeners.get('tour')!({ data: '[]' });
        });

        expect(await screen.findByText('The new line')).toBeTruthy();
    });

    it("shows the new review's conversation once opening a new commit retires the old one", async () => {
        serve(review());
        vi.spyOn(ReviewClient.prototype, 'listReviewTurns')
            .mockResolvedValueOnce([turn(1, 'assistant', 'About the old commit')])
            .mockResolvedValue([]);
        await open();

        expect(await screen.findByText(/Ask anything about this change/)).toBeTruthy();
        expect(screen.queryByText('About the old commit')).toBeNull();
    });

    it('takes no messages once the branch has moved on', async () => {
        serve(review({ stale: true }));
        await open();

        await screen.findByRole('button', { name: 'Review the new commit' });
        expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Walk me through this' }) as HTMLButtonElement).disabled).toBe(true);
    });
});
