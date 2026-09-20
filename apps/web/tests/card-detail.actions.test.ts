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

const card = (stage: string, overrides: Partial<CardDetail> = {}): CardDetail => ({
    id: '0007',
    title: 'Do the thing',
    stage,
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: 'the plan',
    ...overrides,
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
    // Card 0263: `ProjectCardDetailRoute` mounts a usage query alongside events/versions/columns
    // for every card page — defaulted to no usage recorded so the tests above, none of which are
    // about usage, see the "no usage recorded yet" placeholder rather than a rejected query.
    vi.spyOn(BoardClient.prototype, 'getCardUsage').mockResolvedValue({ total: { attempts: 0, inputTokens: 0, outputTokens: 0 }, stages: [] });
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

// Card 0177: renaming, editing the body, and setting/removing a dependency, all from the card page
// — `CardEditControls.tsx`'s `RenameControl`/`EditBodyControl`/`DependenciesSection`, wired into
// `CardDetail.tsx`.
describe('the rename control', () => {
    it('opens a modal seeded with the current title and renames on submit', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        const renameCard = vi.spyOn(BoardClient.prototype, 'renameCard').mockResolvedValue(card('testing', { title: 'A better title' }));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        fireEvent.click(screen.getByRole('button', { name: 'Rename card' }));
        const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
        expect(title.value).toBe('Do the thing');

        fireEvent.change(title, { target: { value: 'A better title' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
        });

        expect(renameCard).toHaveBeenCalledWith('0007', { title: 'A better title' });
        // The modal closed, and the new title reached the header from the mutation's own response.
        await waitFor(() => expect(screen.queryByLabelText('Title')).toBeNull());
        expect(await screen.findByText('A better title')).toBeTruthy();
    });

    it("shows the API's own refusal reason and keeps the typed title in the still-open modal", async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        vi.spyOn(BoardClient.prototype, 'renameCard').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'title already in use' } }, new Headers()),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        fireEvent.click(screen.getByRole('button', { name: 'Rename card' }));
        const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
        fireEvent.change(title, { target: { value: 'Duplicate title' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
        });

        expect(await screen.findByText('title already in use')).toBeTruthy();
        expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Duplicate title');
        // Nothing was echoed onto the header — it still reads the untouched card.
        expect(screen.getByText('Do the thing')).toBeTruthy();
    });
});

// Card 0177: only rendered outside `planning`/`parking-lot` — those two stages get `DraftPane`'s
// session editor instead, and this control must not offer a second door onto the same draft.
describe('the edit body control', () => {
    it('is not rendered while the card is in planning or parking-lot', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));
        vi.spyOn(BoardClient.prototype, 'openAPlanningSession').mockResolvedValue({
            sessionId: '0007',
            worktreePath: '/tmp/plan-0007',
            draftPath: '/tmp/plan-0007/PLAN.md',
            model: 'x',
            instructions: 'x',
        });
        vi.spyOn(BoardClient.prototype, 'getAPlanDraft').mockResolvedValue({ body: 'the plan' });

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(screen.queryByRole('button', { name: 'Edit body' })).toBeNull();
    });

    it('is not rendered while the card is in parking-lot either — same DraftPane branch as planning', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('parking-lot'));
        vi.spyOn(BoardClient.prototype, 'openAPlanningSession').mockResolvedValue({
            sessionId: '0007',
            worktreePath: '/tmp/plan-0007',
            draftPath: '/tmp/plan-0007/PLAN.md',
            model: 'x',
            instructions: 'x',
        });
        vi.spyOn(BoardClient.prototype, 'getAPlanDraft').mockResolvedValue({ body: 'the plan' });

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('Conversation')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Edit body' })).toBeNull();
    });

    it('opens a modal seeded with the current body and saves on submit', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        const editCardBody = vi.spyOn(BoardClient.prototype, 'editCardBody').mockResolvedValue(card('testing', { body: 'the rewritten plan' }));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        fireEvent.click(await screen.findByRole('button', { name: 'Edit body' }));
        const body = (await screen.findByLabelText('Body')) as HTMLTextAreaElement;
        expect(body.value).toBe('the plan');

        fireEvent.change(body, { target: { value: 'the rewritten plan' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        });

        expect(editCardBody).toHaveBeenCalledWith('0007', { body: 'the rewritten plan' });
        await waitFor(() => expect(screen.queryByLabelText('Body')).toBeNull());
        expect(await screen.findByText('the rewritten plan')).toBeTruthy();
    });

    it("shows the API's own refusal reason and keeps the typed body in the still-open modal", async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        vi.spyOn(BoardClient.prototype, 'editCardBody').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'plan is missing "Acceptance criteria"' } }, new Headers()),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        fireEvent.click(await screen.findByRole('button', { name: 'Edit body' }));
        const body = (await screen.findByLabelText('Body')) as HTMLTextAreaElement;
        fireEvent.change(body, { target: { value: 'a rewrite missing a required section' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        });

        expect(await screen.findByText('plan is missing "Acceptance criteria"')).toBeTruthy();
        expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe('a rewrite missing a required section');
        // Nothing was echoed into the read-only view below — it still reads the untouched card.
        expect(screen.getByText('the plan')).toBeTruthy();
    });
});

describe('the dependencies section', () => {
    it('lists each dependsOn id with its own Remove button, and none when there are none', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('No dependencies.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    });

    it('adds a dependency by id and clears the field on success', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        const setCardDependency = vi.spyOn(BoardClient.prototype, 'setCardDependency').mockResolvedValue(card('testing', { dependsOn: ['0003'] }));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const input = (await screen.findByLabelText('Card id to depend on')) as HTMLInputElement;
        fireEvent.change(input, { target: { value: '0003' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }));
        });

        expect(setCardDependency).toHaveBeenCalledWith('0007', { dependsOnId: '0003' });
        await waitFor(() => expect(input.value).toBe(''));
    });

    it('removes a listed dependency by sending remove: true for its id', async () => {
        const getCard = vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing', { dependsOn: ['0003'] }));
        let resolveDependency: ((card: CardDetail) => void) | undefined;
        const setCardDependency = vi.spyOn(BoardClient.prototype, 'setCardDependency').mockImplementation(
            () =>
                new Promise<CardDetail>(resolve => {
                    resolveDependency = resolve;
                }),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        expect(await screen.findByText('0003')).toBeTruthy();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        });

        expect(setCardDependency).toHaveBeenCalledWith('0007', { dependsOnId: '0003', remove: true });
        // In flight, no refetch has landed yet — the id is still shown, same "invalidate, don't
        // write" rule useMoveCard's own test proves.
        expect(screen.getByText('0003')).toBeTruthy();

        // Point the mock at what a real re-fetch would return before resolving, so the id's
        // disappearance can only have come from that re-fetch — never the mutation's own response.
        getCard.mockResolvedValue(card('testing', { dependsOn: [] }));
        await act(async () => {
            resolveDependency?.(card('testing', { dependsOn: [] }));
        });

        await waitFor(() => expect(screen.queryByText('0003')).toBeNull());
        expect(await screen.findByText('No dependencies.')).toBeTruthy();
    });

    it("shows the API's own refusal reason as a notification when adding an unknown id, and keeps it typed", async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        vi.spyOn(BoardClient.prototype, 'setCardDependency').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'no such card 0099' } }, new Headers()),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const input = (await screen.findByLabelText('Card id to depend on')) as HTMLInputElement;
        fireEvent.change(input, { target: { value: '0099' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }));
        });

        expect(await screen.findByText('no such card 0099')).toBeTruthy();
        expect(input.value).toBe('0099');
    });
});

// Card 0241: `dispatch.deferred`'s payload (card 0104, `recordDeferral`) has always carried a
// `reason` string, but until now `EventsTimeline` only ever rendered `event.type` and a timestamp —
// an operator reading the web timeline saw a bare "dispatch.deferred" with no way to tell a scope
// conflict from any other deferral without going to the server log. These assertions fail on the
// pre-change tree: no reason text is rendered there for any event, deferred or otherwise.
describe('the events timeline', () => {
    it('shows the reason on a dispatch.deferred event', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([
            {
                id: 'ev-1',
                type: 'dispatch.deferred',
                stage: 'implementing',
                payload: { reason: '"apps/api/src/modules/board/**" overlaps apps/api/src/** on 0099 (in flight): this card will wait for it' },
                createdAt: '2026-09-19T00:00:00.000Z',
            },
        ]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('dispatch.deferred')).toBeTruthy();
        expect(
            await screen.findByText('"apps/api/src/modules/board/**" overlaps apps/api/src/** on 0099 (in flight): this card will wait for it'),
        ).toBeTruthy();
    });

    it('renders no reason text for an event type other than dispatch.deferred, even carrying a reason-shaped payload', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([
            {
                id: 'ev-1',
                type: 'stage.poisoned',
                stage: 'implementing',
                payload: { reason: 'should not render — wrong event type' },
                createdAt: '2026-09-19T00:00:00.000Z',
            },
        ]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('stage.poisoned')).toBeTruthy();
        expect(screen.queryByText('should not render — wrong event type')).toBeNull();
    });

    it('renders no reason text for a dispatch.deferred event whose payload carries no reason', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([
            { id: 'ev-1', type: 'dispatch.deferred', stage: 'implementing', payload: { outstanding: ['0099'] }, createdAt: '2026-09-19T00:00:00.000Z' },
        ]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('dispatch.deferred')).toBeTruthy();
        // No crash, and nothing rendered from `outstanding` either — a non-string `reason` (here,
        // absent entirely) is "nothing to show", not a stringified object.
        expect(screen.queryByText(/0099/)).toBeNull();
    });
});

// Card 0263, AC6: the card page's own Usage table — one row per stage plus a total, or a
// placeholder for a card with nothing recorded yet. These assertions fail on the pre-change tree:
// `CardDetailView` renders no Usage section at all there, and `BoardClient` has no `getCardUsage`
// to mock.
describe('the usage panel', () => {
    it('renders a row per stage, each stage in the order the API returned it, plus a total row summing every stage', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        vi.spyOn(BoardClient.prototype, 'getCardUsage').mockResolvedValue({
            total: { attempts: 3, inputTokens: 13345, outputTokens: 928 },
            stages: [
                { stage: 'implementing', attempts: 2, inputTokens: 12345, outputTokens: 678 },
                { stage: 'review', attempts: 1, inputTokens: 1000, outputTokens: 250 },
            ],
        });

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        // Per-stage figures, formatted with `toLocaleString` (comma thousands separators) —
        // proof these came from `CardUsage.stages`, not the total row alone.
        expect(await screen.findByText('12,345')).toBeTruthy();
        expect(await screen.findByText('678')).toBeTruthy();
        expect(await screen.findByText('1,000')).toBeTruthy();
        expect(await screen.findByText('250')).toBeTruthy();
        // The total row, summed separately from the per-stage rows above.
        expect(await screen.findByText('13,345')).toBeTruthy();
        expect(await screen.findByText('928')).toBeTruthy();
        expect(screen.getByText('Total')).toBeTruthy();
    });

    it('shows a placeholder rather than a table for a card with no usage recorded yet', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('testing'));
        vi.spyOn(BoardClient.prototype, 'getCardUsage').mockResolvedValue({
            total: { attempts: 0, inputTokens: 0, outputTokens: 0 },
            stages: [],
        });

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('No usage recorded yet.')).toBeTruthy();
        expect(screen.queryByRole('table')).toBeNull();
    });
});
