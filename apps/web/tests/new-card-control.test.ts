// @vitest-environment jsdom
//
// Card 0142: the board gains its one control for filing a card — `NewCardControl`, rendered by
// `routes/index.tsx` beside the refresh button. These tests render the real route tree at `/` (the
// same approach board.dnd.test.ts and card-detail.actions.test.ts take) with `wilson`'s SDK calls
// mocked, so the modal wiring, the `parking-lot`-only stage, the skeleton seed, the navigate-on-
// success, and the keep-what-was-typed-on-refusal behaviour are all exercised as actually written —
// not re-implemented here.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { BoardColumns, CardDetail, CardSummary } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { routeTree } from '#src/routeTree.gen.js';

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'testing'],
    nonStages: ['parking-lot', 'merged'],
};

const detail = (id: string, title: string): CardDetail => ({
    id,
    title,
    stage: 'parking-lot',
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: '## Note\n\nsomething',
});

/** `AppShell.Main`/`Board` measure themselves with `ResizeObserver` on mount; jsdom has none. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

/** The feed subscription `__root.tsx` mounts on every route; jsdom has no real `EventSource`. */
class FakeEventSource {
    addEventListener() {}
    close() {}
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
    vi.spyOn(wilson.board, 'listBoardColumns').mockResolvedValue(columns);
    vi.spyOn(wilson.board, 'listCards').mockResolvedValue([] as CardSummary[]);
    vi.spyOn(wilson.board, 'listCardEvents').mockResolvedValue([]);
    vi.spyOn(wilson.board, 'listCardVersions').mockResolvedValue([]);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('scrollTo', vi.fn());
    // jsdom does not implement matchMedia; MantineProvider (and CardDetail's PlanningPanes,
    // reached after a successful navigate) reads it on mount regardless of what renders.
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
    // jsdom has no Font Loading API. `NewCardControl`'s body field is a Mantine `Textarea autosize`
    // (this card's Constraints), which listens for `document.fonts`'s `loadingdone` event to
    // re-measure itself — stubbed here, not shimmed in production code, since this is purely a
    // test-environment gap (the same stub card-detail.actions.test.ts needs for its own `autosize`
    // Textarea).
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
});

/** Opens the modal and returns its title/body fields. */
async function openModal() {
    const button = await screen.findByRole('button', { name: 'New card' });
    fireEvent.click(button);
    const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
    const body = (await screen.findByLabelText('Body')) as HTMLTextAreaElement;
    return { title, body };
}

describe('the board toolbar', () => {
    it('offers a "New card" control beside the refresh button', async () => {
        renderApp('/');
        expect(await screen.findByRole('button', { name: 'New card' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Refresh the board' })).toBeTruthy();
    });
});

describe('filing a card', () => {
    it('opens with the body already seeded from the six-heading skeleton, and closes on Cancel without creating anything', async () => {
        const createCard = vi.spyOn(wilson.board, 'createCard');
        renderApp('/');

        const { body } = await openModal();
        expect(body.value).toContain('## Goal');
        expect(body.value).toContain('## Constraints');
        expect(body.value).toContain('## Files in scope');
        expect(body.value).toContain('## Tasks');
        expect(body.value).toContain('## Acceptance criteria');
        expect(body.value).toContain('## Out of scope');

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByLabelText('Title')).toBeNull());
        expect(createCard).not.toHaveBeenCalled();
    });

    it('disables Create until a title is typed, even with the seeded body present', async () => {
        renderApp('/');
        const { title } = await openModal();

        expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);

        fireEvent.change(title, { target: { value: 'Fix the thing' } });
        await waitFor(() => expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(false));
    });

    it('files into parking-lot with the (possibly edited) body, and lands on the new card without a stage picker anywhere in the form', async () => {
        const createCard = vi.spyOn(wilson.board, 'createCard').mockResolvedValue(detail('0150', 'Capture this thought'));
        vi.spyOn(wilson.board, 'getCard').mockResolvedValue(detail('0150', 'Capture this thought'));
        const { router } = renderApp('/');

        const { title, body } = await openModal();
        // No stage picker in the form at all — this control never offers one (the plan's
        // "default to parking-lot" constraint), unlike the move control on a card's own page.
        expect(screen.queryByRole('combobox', { name: /stage/i })).toBeNull();

        fireEvent.change(title, { target: { value: 'Capture this thought' } });
        fireEvent.change(body, { target: { value: '## Note\n\nsomething worth capturing' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Create' }));
        });

        expect(createCard).toHaveBeenCalledWith({
            title: 'Capture this thought',
            stage: 'parking-lot',
            body: '## Note\n\nsomething worth capturing',
        });

        await waitFor(() => expect(router.state.location.pathname).toBe('/cards/0150'));
        expect(await screen.findByText('Capture this thought')).toBeTruthy();
        // The modal closed rather than staying open over the new page.
        expect(screen.queryByLabelText('Title')).toBeNull();
    });

    it('trims a title padded with whitespace before sending it', async () => {
        const createCard = vi.spyOn(wilson.board, 'createCard').mockResolvedValue(detail('0151', 'Padded'));
        vi.spyOn(wilson.board, 'getCard').mockResolvedValue(detail('0151', 'Padded'));
        renderApp('/');

        const { title } = await openModal();
        fireEvent.change(title, { target: { value: '  Padded  ' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Create' }));
        });

        expect(createCard).toHaveBeenCalledWith(expect.objectContaining({ title: 'Padded' }));
    });

    it("shows the server's own refusal sentence and keeps the typed title and body on screen, rather than losing them", async () => {
        vi.spyOn(wilson.board, 'createCard').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'title already in use' } }, new Headers()),
        );
        const { router } = renderApp('/');

        const { title, body } = await openModal();
        fireEvent.change(title, { target: { value: 'Duplicate title' } });
        fireEvent.change(body, { target: { value: 'my own words, not the skeleton' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Create' }));
        });

        expect(await screen.findByText('title already in use')).toBeTruthy();
        // The generic SDK message would be a regression — the runner's own sentence must render.
        expect(screen.queryByText('400 Bad Request')).toBeNull();

        // Still on the board, modal still open, nothing typed was lost.
        expect(router.state.location.pathname).toBe('/');
        expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Duplicate title');
        expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe('my own words, not the skeleton');
    });

    it('accepts a card filed with plain prose instead of the skeleton headings', async () => {
        const createCard = vi.spyOn(wilson.board, 'createCard').mockResolvedValue(detail('0152', 'Just a note'));
        vi.spyOn(wilson.board, 'getCard').mockResolvedValue(detail('0152', 'Just a note'));
        renderApp('/');

        const { title, body } = await openModal();
        fireEvent.change(title, { target: { value: 'Just a note' } });
        fireEvent.change(body, { target: { value: 'Remember to check the flaky test on CI.' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Create' }));
        });

        expect(createCard).toHaveBeenCalledWith({
            title: 'Just a note',
            stage: 'parking-lot',
            body: 'Remember to check the flaky test on CI.',
        });
    });

    it('reopening after a cancel starts fresh again — no leftover title or edited body from the previous attempt', async () => {
        renderApp('/');

        const first = await openModal();
        fireEvent.change(first.title, { target: { value: 'Abandoned draft' } });
        fireEvent.change(first.body, { target: { value: 'edited away from the skeleton' } });
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByLabelText('Title')).toBeNull());

        const second = await openModal();
        expect(second.title.value).toBe('');
        expect(second.body.value).toContain('## Goal');
        expect(second.body.value).not.toContain('edited away from the skeleton');
    });
});
