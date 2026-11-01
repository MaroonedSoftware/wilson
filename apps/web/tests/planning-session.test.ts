import { DateTime } from 'luxon';
// @vitest-environment jsdom
//
// Card 0137: a card in `planning` gets a two-pane session — the conversation
// (`PlanningSessionPane`, `lib/plan.ts`'s `usePlanTranscript`) beside the card's current body,
// read-only, standing in for the draft pane [[0138]] builds. Every other stage keeps rendering
// exactly as it did before. These tests render the real route tree (the same approach
// card-detail.actions.test.ts takes) with the SDK's calls mocked, so the two-pane gating, the
// streamed transcript, the composer, and the inline failure surfaces are all exercised as actually
// wired up in CardDetail.tsx and PlanningSession.tsx.
//
// Card 0155 moved the card's own page to `/projects/$project/cards/$cardId`, which reads
// `getCard`/`listCardEvents`/`listCardVersions`/`listBoardColumns`/`openAPlanningSession` through
// `wilsonForProject(project)` — a client built fresh per route (`lib/sdk.ts`), not the singleton
// `wilson` this file used to mock directly. The mock now sits on `BoardClient`'s own prototype
// (shared by every instance, the singleton included), the same fix `card-detail.actions.test.ts`
// made for the same reason. `getAPlanDraft`/`sendAPlanTurn` still go through the singleton
// (`lib/plan.ts`/`lib/mutations.ts` — card [[0156]]'s own scope, untouched here), so those two stay
// mocked on `wilson.board` exactly as before.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, SdkError } from '@wilson/sdk';
import type { BoardColumns, CardDetail, PlanTurn } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { routeTree } from '#src/routeTree.gen.js';

/** Every test below opens this card at its project-scoped URL — the only kind there is since
 * card 0155 deleted `/cards/$cardId`. */
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
    body: 'the current plan body',
});

const session = { sessionId: '0007', worktreePath: '/tmp/plan-0007', draftPath: '/tmp/plan-0007/PLAN.md', model: 'x', instructions: 'x' };

const turn = (seq: number, overrides: Partial<PlanTurn> = {}): PlanTurn => ({
    seq,
    role: 'assistant',
    content: `turn ${seq}`,
    createdAt: DateTime.fromISO('2026-08-27T00:00:00.000Z'),
    ...overrides,
});

/**
 * A stand-in for the browser's `EventSource`, shared by both the board feed (mounted on every
 * route) and, for a `planning` card, `usePlanTranscript`'s own subscription. Recording every
 * instance's URL lets a test tell the two apart without caring which happens to open first.
 */
class FakeEventSource {
    static instances: FakeEventSource[] = [];

    readonly url: string;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
        const set = this.listeners.get(type) ?? new Set();
        set.add(listener);
        this.listeners.set(type, set);
    }

    close() {
        this.closed = true;
    }

    emit(type: string, data = '') {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(new MessageEvent(type, { data }));
        }
    }
}

const planStreamSources = () => FakeEventSource.instances.filter(source => source.url.includes('/plan/stream'));
const latestPlanStream = () => planStreamSources()[planStreamSources().length - 1]!;

/** `AppShell.Main` renders inside Mantine's `ScrollArea`, which measures itself with
 * `ResizeObserver` on mount — jsdom does not implement it. Same stand-in flagged.test.ts uses. */
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
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
    return { router };
}

beforeEach(() => {
    // These four are read through the project-scoped route's own client
    // (`wilsonForProject(project)`, `projects.$project.cards.$cardId.tsx`) — the mock has to sit on
    // `BoardClient`'s own prototype (shared by every instance) rather than on the singleton
    // `wilson.board` other files' fixtures mock. See this file's header.
    vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
    vi.spyOn(BoardClient.prototype, 'openAPlanningSession').mockResolvedValue(session);
    // Card [[0138]]'s `DraftPane` (the other half of this two-pane view) fetches the session's
    // draft unconditionally whenever `planning` renders — every test in this file gets it
    // pre-mocked to the same body `card()` returns, so a suite that isn't specifically exercising
    // the draft pane itself (draft-pane.test.ts covers that) doesn't have to think about it.
    vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'the current plan body' });
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Element.prototype.scrollIntoView = vi.fn();

    // jsdom has no Font Loading API. Mantine's `Textarea autosize` (the composer, card 0137) listens
    // for `document.fonts`' `loadingdone` event to re-measure itself — a stub here, not a shim in
    // production source, since this is purely a test-environment gap.
    Object.defineProperty(document, 'fonts', {
        value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        configurable: true,
    });

    // jsdom does not implement matchMedia; MantineProvider reads it on mount, and `CardDetail.tsx`'s
    // `useMediaQuery(NARROW_BREAKPOINT)` reads it too — `matches: false` keeps every test on the
    // side-by-side `Grid` layout rather than the narrow `Tabs` one.
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

describe('a card in planning', () => {
    it('renders the two-pane session — conversation and the live, editable draft (card [[0138]]) — and opens the plan stream', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('Conversation')).toBeTruthy();
        expect(screen.getByText('Plan')).toBeTruthy();
        // Card [[0138]] replaces the read-only placeholder with an editable draft fetched via
        // `getAPlanDraft` — the session's draft, not `card.body`, lands in a `Textarea`, not plain
        // text.
        const draft = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(draft.value).toBe('the current plan body'));
        // The approve control exists (card [[0138]]'s decision gate) but starts disabled: the
        // fetched draft is identical to the card's current body, so there is nothing yet to approve.
        expect((screen.getByRole('button', { name: 'Approve…' }) as HTMLButtonElement).disabled).toBe(true);

        await waitFor(() => expect(planStreamSources()).toHaveLength(1));
        expect(latestPlanStream().url).toContain('/api/cards/0007/plan/stream');
        expect(BoardClient.prototype.openAPlanningSession).toHaveBeenCalledWith('0007');
    });

    it('renders a turn already on the transcript, and an in-progress reply as it streams in rather than leaving it absent', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await waitFor(() => expect(planStreamSources()).toHaveLength(1));

        act(() => latestPlanStream().onopen?.());
        act(() => latestPlanStream().emit('turn', JSON.stringify(turn(1, { role: 'user', content: 'What should the plan cover?' }))));

        expect(await screen.findByText('What should the plan cover?')).toBeTruthy();

        act(() => latestPlanStream().emit('delta', 'Here is the first '));
        expect(await screen.findByText(/Here is the first/)).toBeTruthy();

        act(() => latestPlanStream().emit('delta', 'part of the reply.'));
        expect(await screen.findByText('Here is the first part of the reply.')).toBeTruthy();
    });

    it('sends a turn from the composer, echoes it immediately, and folds the reply in on success', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));
        let resolveTurn: ((turn: PlanTurn) => void) | undefined;
        const sendAPlanTurn = vi.spyOn(wilson.board, 'sendAPlanTurn').mockImplementation(
            () =>
                new Promise<PlanTurn>(resolve => {
                    resolveTurn = resolve;
                }),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await waitFor(() => expect(BoardClient.prototype.openAPlanningSession).toHaveBeenCalled());

        const textarea = await screen.findByRole('textbox', { name: 'Message' });
        const send = screen.getByRole('button', { name: 'Send' });
        fireEvent.change(textarea, { target: { value: 'Please plan the thing' } });
        await act(async () => {
            fireEvent.click(send);
        });

        expect(sendAPlanTurn).toHaveBeenCalledWith('0007', { text: 'Please plan the thing' });
        // Echoed the moment it's sent — the literal text just submitted, before any round trip.
        expect(await screen.findByText('Please plan the thing')).toBeTruthy();
        expect((send as HTMLButtonElement).disabled).toBe(true);

        await act(async () => {
            resolveTurn?.(turn(1, { role: 'assistant', content: 'Sure — here is a plan.' }));
        });

        expect(await screen.findByText('Sure — here is a plan.')).toBeTruthy();
    });

    /**
     * Card 0240: a "Propose cuts" control sends the same textarea contents as an ordinary turn, but
     * as `{ text, mode: 'cuts' }` instead of `{ text }` — and its reply folds into the transcript the
     * same way, since it is still just a turn.
     */
    it('sends a "Propose cuts" turn with mode "cuts", and its reply folds into the transcript like any other turn', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));
        let resolveTurn: ((turn: PlanTurn) => void) | undefined;
        const sendAPlanTurn = vi.spyOn(wilson.board, 'sendAPlanTurn').mockImplementation(
            () =>
                new Promise<PlanTurn>(resolve => {
                    resolveTurn = resolve;
                }),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await waitFor(() => expect(BoardClient.prototype.openAPlanningSession).toHaveBeenCalled());

        const textarea = await screen.findByRole('textbox', { name: 'Message' });
        const proposeCuts = screen.getByRole('button', { name: 'Propose cuts' });
        fireEvent.change(textarea, { target: { value: 'Trim task 3' } });
        await act(async () => {
            fireEvent.click(proposeCuts);
        });

        expect(sendAPlanTurn).toHaveBeenCalledWith('0007', { text: 'Trim task 3', mode: 'cuts' });
        expect(await screen.findByText('Trim task 3')).toBeTruthy();
        expect((proposeCuts as HTMLButtonElement).disabled).toBe(true);

        await act(async () => {
            resolveTurn?.(turn(1, { role: 'assistant', content: 'Here are the cuts I would propose.' }));
        });

        expect(await screen.findByText('Here are the cuts I would propose.')).toBeTruthy();
    });

    it('"Propose cuts" sends even with an empty composer, unlike "Send" which stays gated on non-empty text', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));
        const sendAPlanTurn = vi
            .spyOn(wilson.board, 'sendAPlanTurn')
            .mockResolvedValue(turn(1, { role: 'assistant', content: 'Here are some cuts.' }));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await waitFor(() => expect(BoardClient.prototype.openAPlanningSession).toHaveBeenCalled());

        const send = screen.getByRole('button', { name: 'Send' });
        await act(async () => {
            fireEvent.click(send);
        });
        expect(sendAPlanTurn).not.toHaveBeenCalled();

        const proposeCuts = screen.getByRole('button', { name: 'Propose cuts' });
        await act(async () => {
            fireEvent.click(proposeCuts);
        });

        expect(sendAPlanTurn).toHaveBeenCalledWith('0007', { text: '', mode: 'cuts' });
    });

    it('"Draft the plan" sends a draft turn with an empty composer, and carries anything typed as guidance', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));
        const sendAPlanTurn = vi
            .spyOn(wilson.board, 'sendAPlanTurn')
            .mockResolvedValue(turn(1, { role: 'assistant', content: 'The plan is in the draft.' }));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await waitFor(() => expect(BoardClient.prototype.openAPlanningSession).toHaveBeenCalled());

        const draftThePlan = await screen.findByRole('button', { name: 'Draft the plan' });
        await waitFor(() => expect((draftThePlan as HTMLButtonElement).disabled).toBe(false));
        await act(async () => {
            fireEvent.click(draftThePlan);
        });
        expect(sendAPlanTurn).toHaveBeenCalledWith('0007', { text: '', mode: 'draft' });
        await screen.findByText('The plan is in the draft.');

        const textarea = await screen.findByRole('textbox', { name: 'Message' });
        await act(async () => {
            fireEvent.change(textarea, { target: { value: 'keep it to the API' } });
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Draft the plan' }));
        });
        expect(sendAPlanTurn).toHaveBeenLastCalledWith('0007', { text: 'keep it to the API', mode: 'draft' });
    });

    it("shows the server's own refusal sentence inline next to the composer, not a generic message", async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));
        vi.spyOn(wilson.board, 'sendAPlanTurn').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'this card has no open planning session' } },
                new Headers(),
            ),
        );

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await waitFor(() => expect(BoardClient.prototype.openAPlanningSession).toHaveBeenCalled());

        const textarea = await screen.findByRole('textbox', { name: 'Message' });
        fireEvent.change(textarea, { target: { value: 'hello' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        });

        expect(await screen.findByText('this card has no open planning session')).toBeTruthy();
        expect(screen.queryByText('400 Bad Request')).toBeNull();
        // Review-flagged blocker: the composer used to clear its text synchronously right after
        // calling mutate(), discarding the operator's message before the refusal even came back.
        // The textarea's own doc comment says a refusal leaves the text in place to edit and
        // resend — assert the box still holds exactly what was typed, not emptied out from under it.
        expect((textarea as HTMLTextAreaElement).value).toBe('hello');
    });

    it('shows an inline alert when the stream fails to open, instead of swallowing the failure', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        await waitFor(() => expect(planStreamSources()).toHaveLength(1));

        act(() => latestPlanStream().onerror?.());

        expect(await screen.findByText('Stream disconnected')).toBeTruthy();
        expect(screen.getByText('Could not connect to the planning conversation.')).toBeTruthy();
    });

    it('opens exactly one session for the card, not a second one on top of it', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('planning'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        await waitFor(() => expect(BoardClient.prototype.openAPlanningSession).toHaveBeenCalledTimes(1));
        // Give any stray effect a turn to run before asserting it stayed at one.
        await act(async () => {});
        expect(BoardClient.prototype.openAPlanningSession).toHaveBeenCalledTimes(1);
    });
});

describe('a card in parking-lot', () => {
    /**
     * Card 0159: `CardDetailView` now gives `parking-lot` the same two-pane session `planning` has
     * always had — a parked card is a second way into the conversation cards [[0137]]/[[0138]]
     * built, not a new or different rendering of it.
     */
    it('renders the same two-pane session "planning" gets, and opens the plan stream', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('parking-lot'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('Conversation')).toBeTruthy();
        expect(screen.getByText('Plan')).toBeTruthy();
        const draft = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(draft.value).toBe('the current plan body'));

        await waitFor(() => expect(planStreamSources()).toHaveLength(1));
        expect(latestPlanStream().url).toContain('/api/cards/0007/plan/stream');
        expect(BoardClient.prototype.openAPlanningSession).toHaveBeenCalledWith('0007');
    });
});

describe('a card outside planning', () => {
    it('renders exactly as before — no session UI, and no plan stream opened', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card('implementing'));

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(screen.queryByText('Conversation')).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
        // The plain read-only plan heading and body this stage has always rendered — now inside
        // the "Plan" tab card 0265 adds beside "Diff" for every stage outside planning/parking-lot,
        // so plain `getByText('Plan')` is ambiguous between the tab label and this heading.
        expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy();
        expect(screen.getByText('the current plan body')).toBeTruthy();

        expect(BoardClient.prototype.openAPlanningSession).not.toHaveBeenCalled();
        expect(planStreamSources()).toHaveLength(0);
    });
});
