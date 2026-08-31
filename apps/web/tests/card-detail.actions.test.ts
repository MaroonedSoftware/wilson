// @vitest-environment jsdom
//
// Card 0037: the card detail page gains its two operator actions — move the card to another
// stage, and enqueue it for the one it's in. Both endpoints (card 0080) and the SDK methods
// already existed before this card; what's new is `lib/mutations.ts`'s `useMoveCard`/`useStartCard`
// and the `MoveControl`/`EnqueueButton` this card adds to `CardDetail.tsx`. These tests render the
// real route tree (the same approach flagged.test.ts and settings.test.ts take) with the SDK's
// calls mocked, so the mutation wiring, the invalidate-not-patch rule, and the refusal-surfacing are
// all exercised as actually written.
//
// Card 0155 moved the card's own page to `/projects/$project/cards/$cardId`, which reads through
// `wilsonForProject(project)` — a client built fresh per route (`lib/sdk.ts`), not the singleton
// `wilson` this file used to mock directly. The mock now sits on `BoardClient`'s own prototype
// (shared by every instance, the singleton included), the same fix `project-routes.test.ts` made
// for the same reason.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, SdkError } from '@wilson/sdk';
import type { BoardColumns, CardDetail } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

/** Every test below opens this card at its project-scoped URL. */
const CARD_PATH = '/projects/demo/cards/0007';

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'testing'],
    nonStages: ['parking-lot', 'merged'],
};

const card = (stage: string): CardDetail => ({
    id: '0007',
    title: 'Do the thing',
    stage,
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: 'the plan',
});

/** A flagged card, for the needs-human panel's own tests below. */
const flaggedCard = (stage: string): CardDetail => ({
    ...card(stage),
    needsHuman: true,
    needsHumanReason: 'the job crashed twice in a row',
});

/**
 * The root layout mounts `useCardFeed` on every route — jsdom has no `EventSource`, so without a
 * stand-in the shell throws before `/cards/$cardId` ever renders. Not the behaviour under test.
 */
class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

/**
 * `AppShell.Main` renders inside Mantine's `ScrollArea`, which measures itself with
 * `ResizeObserver` on mount — jsdom does not implement it, and every test here renders the app
 * shell (via `/cards/$cardId`), not just ones about scrolling. Same stand-in flagged.test.ts uses.
 */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

/** Renders the real app router (root layout + whichever route the path resolves to). */
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
    vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // jsdom has no layout engine, so floating-ui's own `scrollIntoView` call on the active option
    // (part of Mantine's Combobox opening its dropdown) throws without a stand-in — nothing to do
    // with the behaviour under test, just what opening a `Select` drags in under jsdom.
    Element.prototype.scrollIntoView = vi.fn();

    // jsdom does not implement matchMedia; MantineProvider reads it (colour-scheme detection) on
    // mount regardless of what this test renders.
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
    // TanStack Router's scroll restoration calls this on navigation; jsdom does not implement it.
    vi.stubGlobal('scrollTo', vi.fn());

    // jsdom has no Font Loading API. Since card 0137, a `planning`-stage card (several tests below
    // use `card('planning')`, incidentally to this file's own MoveControl assertions) renders
    // `PlanningSessionPane`, whose composer is a Mantine `Textarea autosize` — it listens for
    // `document.fonts`'s `loadingdone` event to re-measure itself. Stubbed here, not shimmed in
    // production code, since this is purely a test-environment gap.
    Object.defineProperty(document, 'fonts', {
        value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        configurable: true,
    });
});

afterEach(() => {
    // `apps/web/vitest.config.ts` does not set `test.globals: true`, so `@testing-library/react`'s
    // own auto-cleanup never registers — without this, each test's `render()` piles onto the
    // previous test's DOM instead of replacing it.
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // `@mantine/notifications` keeps its queue in a module-level store, outside the React tree
    // `cleanup()` unmounts — without this, a notification a passing test shows outlives it, and a
    // later test asserting on a notification's text can find that older one instead (or never find
    // its own, once the display limit is reached by everything still queued ahead of it).
    notifications.clean();
});

describe('the move control', () => {
    it("offers the board's configured stages and non-stages, not a hard-coded list", async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const select = await screen.findByRole('combobox', { name: 'Move to stage' });
        fireEvent.click(select);

        // Both a configured stage and a configured non-stage show up as options — proof the list
        // came from `GET /api/stages`, not something CardDetail.tsx invented. `hidden: true`
        // because Mantine's Combobox keeps its dropdown mounted (toggling `display: none`) rather
        // than mounting/unmounting it, and jsdom's floating-ui position check always reports the
        // target as clipped (no real layout engine) — the dropdown is genuinely open, but
        // `getByRole`'s default visibility filter can't tell that apart from still-closed.
        expect(await screen.findByRole('option', { name: 'testing', hidden: true })).toBeTruthy();
        expect(await screen.findByRole('option', { name: 'parking-lot', hidden: true })).toBeTruthy();
    });

    it('requests a move but does not render the new stage until the query re-fetches', async () => {
        const getCard = vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));
        let resolveMove: ((card: CardDetail) => void) | undefined;
        const moveCard = vi.spyOn(BoardClient.prototype, 'moveCard').mockImplementation(
            () =>
                new Promise<CardDetail>(resolve => {
                    resolveMove = resolve;
                }),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        // Scoped to the badge's own class: the closed `Select` keeps every option's text mounted
        // (hidden) in the DOM too, so an unscoped `getByText('planning')` would find both.
        expect(screen.getByText('planning', { selector: '.mantine-Badge-label' })).toBeTruthy();

        const select = await screen.findByRole('combobox', { name: 'Move to stage' });
        fireEvent.click(select);
        const option = await screen.findByRole('option', { name: 'testing', hidden: true });
        await act(async () => {
            fireEvent.click(option);
        });

        expect(moveCard).toHaveBeenCalledWith('0007', { stage: 'testing' });
        // The request is in flight; the runner hasn't answered yet, so the badge — and the query
        // it reads from — must still say the old stage. Rendering `testing` here would be exactly
        // the optimistic transition the plan forbids.
        expect(screen.getByText('planning', { selector: '.mantine-Badge-label' })).toBeTruthy();
        expect(screen.queryByText('testing', { selector: '.mantine-Badge-label' })).toBeNull();

        // The runner answers, and only now does the mutation invalidate the card query. Point the
        // mock at what a real re-fetch would return before resolving, so the badge's new value can
        // only have come from that re-fetch — never from the mutation's own response body.
        getCard.mockResolvedValue(card('testing'));
        await act(async () => {
            resolveMove?.(card('testing'));
        });

        expect(await screen.findByText('testing', { selector: '.mantine-Badge-label' })).toBeTruthy();
        expect(screen.queryByText('planning', { selector: '.mantine-Badge-label' })).toBeNull();
    });

    it("shows the API's reason when a move is refused, rather than swallowing it", async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));
        vi.spyOn(BoardClient.prototype, 'moveCard').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: '"merged" is not a valid target for this card' } },
                new Headers(),
            ),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const select = await screen.findByRole('combobox', { name: 'Move to stage' });
        fireEvent.click(select);
        const option = await screen.findByRole('option', { name: 'merged', hidden: true });
        await act(async () => {
            fireEvent.click(option);
        });

        expect(await screen.findByText('"merged" is not a valid target for this card')).toBeTruthy();
        // The generic SDK message would be a regression — the runner's own sentence must render.
        expect(screen.queryByText('400 Bad Request')).toBeNull();
        // No optimistic write survives the refusal either.
        expect(screen.getByText('planning', { selector: '.mantine-Badge-label' })).toBeTruthy();
    });
});

describe('the enqueue button', () => {
    it('enqueues the card and disables itself while the request is in flight', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        let resolveStart: ((card: CardDetail) => void) | undefined;
        const startCard = vi.spyOn(BoardClient.prototype, 'startCard').mockImplementation(
            () =>
                new Promise<CardDetail>(resolve => {
                    resolveStart = resolve;
                }),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const button = (await screen.findByRole('button', { name: 'Enqueue' })) as HTMLButtonElement;
        await act(async () => {
            fireEvent.click(button);
        });

        expect(startCard).toHaveBeenCalledWith('0007');
        await waitFor(() => expect(button.disabled).toBe(true));

        await act(async () => {
            resolveStart?.(card('testing'));
        });
    });

    it('refuses a card a job is already carrying, and shows the reason', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        const startCard = vi.spyOn(BoardClient.prototype, 'startCard').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'card 0007 is already carried by job job-42' } },
                new Headers(),
            ),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const button = await screen.findByRole('button', { name: 'Enqueue' });
        await act(async () => {
            fireEvent.click(button);
        });

        expect(startCard).toHaveBeenCalledWith('0007');
        expect(await screen.findByText('card 0007 is already carried by job job-42')).toBeTruthy();
    });

    it('refuses a card whyNotDispatchable rejects, and shows the reason the same way', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        const startCard = vi.spyOn(BoardClient.prototype, 'startCard').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'plan is missing "Acceptance criteria"' } },
                new Headers(),
            ),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const button = await screen.findByRole('button', { name: 'Enqueue' });
        await act(async () => {
            fireEvent.click(button);
        });

        expect(startCard).toHaveBeenCalledWith('0007');
        expect(await screen.findByText('plan is missing "Acceptance criteria"')).toBeTruthy();
    });
});

// Card 0143: the operator's end of the daemon's own hand-merge — a button on a card in `ready`
// that calls `POST .../merge` and, since a conflict or a failed suite is a normal 200
// (`MergeResult.merged: false`) rather than a refusal, always ends in a notification either way.
describe('the merge control', () => {
    it('is not rendered for a card outside ready', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
    });

    it('is rendered for a card in ready', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('ready'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByRole('button', { name: 'Merge' })).toBeTruthy();
    });

    it('merges the card and shows a success notification naming the commit', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('ready'));
        const mergeCard = vi.spyOn(BoardClient.prototype, 'mergeCard').mockResolvedValue({
            ...card('merged'),
            merged: true,
            commit: 'abc1234def5678',
        });

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const button = await screen.findByRole('button', { name: 'Merge' });
        await act(async () => {
            fireEvent.click(button);
        });

        expect(mergeCard).toHaveBeenCalledWith('0007');
        expect(await screen.findByText('Merged')).toBeTruthy();
        expect(await screen.findByText(/abc1234d/)).toBeTruthy();
    });

    // `merged: false` is a normal 200, not a thrown error — the two honest ways an attempt can not
    // land (a conflict or a failed suite), and the reason still has to reach the operator.
    it('shows the reason as a notification when a 200 reports merged: false, rather than swallowing it', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('ready'));
        vi.spyOn(BoardClient.prototype, 'mergeCard').mockResolvedValue({
            ...card('ready'),
            merged: false,
            reason: 'card/0007-do-the-thing conflicts with main: src/index.ts',
        });

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const button = await screen.findByRole('button', { name: 'Merge' });
        await act(async () => {
            fireEvent.click(button);
        });

        expect(await screen.findByText('card/0007-do-the-thing conflicts with main: src/index.ts')).toBeTruthy();
        // The card was never re-fetched into a merged state — only invalidated.
        expect(screen.getByText('ready', { selector: '.mantine-Badge-label' })).toBeTruthy();
    });

    it('shows the reason as a notification when the request itself is refused', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('ready'));
        vi.spyOn(BoardClient.prototype, 'mergeCard').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'cannot merge 0007: it is in "implementing", not "ready"' } },
                new Headers(),
            ),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const button = await screen.findByRole('button', { name: 'Merge' });
        await act(async () => {
            fireEvent.click(button);
        });

        expect(await screen.findByText('cannot merge 0007: it is in "implementing", not "ready"')).toBeTruthy();
    });
});

// Card 0176: the needs-human panel clears the flag itself rather than pointing an operator at a
// terminal (`wilson card ack {id}`) — an Acknowledge button calling `POST .../ack`.
describe('the needs-human panel', () => {
    it('renders an Acknowledge button and no wilson card ack hint', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(flaggedCard('testing'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByRole('button', { name: 'Acknowledge' })).toBeTruthy();
        expect(screen.queryByText(/wilson card ack/)).toBeNull();
    });

    it('acknowledges the card but keeps the panel until the query re-fetches', async () => {
        const getCard = vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(flaggedCard('testing'));
        let resolveAck: ((card: CardDetail) => void) | undefined;
        const acknowledgeAFlaggedCard = vi.spyOn(BoardClient.prototype, 'acknowledgeAFlaggedCard').mockImplementation(
            () =>
                new Promise<CardDetail>(resolve => {
                    resolveAck = resolve;
                }),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const button = await screen.findByRole('button', { name: 'Acknowledge' });
        await act(async () => {
            fireEvent.click(button);
        });

        expect(acknowledgeAFlaggedCard).toHaveBeenCalledWith('0007');
        // The request is in flight; no optimistic clearing — the panel (and its button) still renders.
        expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy();

        getCard.mockResolvedValue(card('testing'));
        await act(async () => {
            resolveAck?.(card('testing'));
        });

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull());
    });

    it("shows the API's reason when acknowledgement is refused, rather than swallowing it", async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(flaggedCard('testing'));
        vi.spyOn(BoardClient.prototype, 'acknowledgeAFlaggedCard').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'card 0007 is not flagged' } },
                new Headers(),
            ),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const button = await screen.findByRole('button', { name: 'Acknowledge' });
        await act(async () => {
            fireEvent.click(button);
        });

        expect(await screen.findByText('card 0007 is not flagged')).toBeTruthy();
        // The panel is still up — no optimistic clearing on a refusal either.
        expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
    });
});

// Card 0176: the safe-cancel counterpart to Enqueue/Merge — a Release button that calls
// `POST .../release` and always ends in a notification, since a refusal (a job genuinely mid-run)
// is the only client-side signal there ever is for "a job carries this card".
describe('the release control', () => {
    it('releases the card and shows a success notification naming releasedAs', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        const releaseCard = vi.spyOn(BoardClient.prototype, 'releaseCard').mockResolvedValue({
            ...card('testing'),
            releasedAs: 'orphan',
        });

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const button = await screen.findByRole('button', { name: 'Release' });
        await act(async () => {
            fireEvent.click(button);
        });

        expect(releaseCard).toHaveBeenCalledWith('0007');
        expect(await screen.findByText('Released')).toBeTruthy();
        expect(await screen.findByText(/orphan/)).toBeTruthy();
    });

    it('shows the reason as a notification when release is refused, rather than swallowing it', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        const releaseCard = vi.spyOn(BoardClient.prototype, 'releaseCard').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'job job-42 is actively running card 0007' } },
                new Headers(),
            ),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const button = await screen.findByRole('button', { name: 'Release' });
        await act(async () => {
            fireEvent.click(button);
        });

        expect(releaseCard).toHaveBeenCalledWith('0007');
        expect(await screen.findByText('job job-42 is actively running card 0007')).toBeTruthy();
    });
});
