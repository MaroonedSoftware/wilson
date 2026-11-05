// @vitest-environment jsdom
//
// The goals pages and the strip in the chat: the real route tree rendered with `wilson`'s SDK calls
// mocked, the way `hosts.test.ts` renders `/hosts`.
import { createElement } from 'react';
import { DateTime } from 'luxon';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal, GoalDetail } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { routeTree } from '#src/routeTree.gen.js';
import { setActiveThread } from '#src/lib/chat.js';
import { STATUS_ACTIONS } from '#src/routes/goals.$goalId.js';

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
    render(
        createElement(
            MantineProvider,
            null,
            createElement(
                QueryClientProvider,
                { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
                createElement(RouterProvider, { router }),
            ),
        ),
    );
    return { router };
}

const AT = DateTime.fromISO('2026-11-05T12:00:00Z');
const goal = (overrides: Partial<Goal> = {}): Goal => ({
    id: '3',
    threadId: '42',
    project: 'ats',
    title: 'Add SSO',
    outcome: 'People sign in with SSO',
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
});
const detail = (overrides: Partial<GoalDetail> = {}): GoalDetail => ({
    goal: goal(),
    cards: [
        { id: '0007', title: 'Add the callback', stage: 'review', needsHuman: false },
        { id: '0008', title: 'Add the login page', stage: 'testing', needsHuman: true },
    ],
    ...overrides,
});

beforeEach(() => {
    vi.spyOn(wilson.board, 'listBoardColumns').mockResolvedValue({ stages: [], nonStages: [] });
    vi.spyOn(wilson.board, 'listCards').mockResolvedValue([]);
    vi.spyOn(wilson.projects, 'listProjects').mockResolvedValue([{ name: 'ats' }]);
    vi.spyOn(wilson.chat, 'listChatThreads').mockResolvedValue([]);
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
    Element.prototype.scrollTo = vi.fn();
    Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener: vi.fn(), removeEventListener: vi.fn() } });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the goals page', () => {
    it('is reachable from the header', async () => {
        vi.spyOn(wilson.goals, 'listGoals').mockResolvedValue([]);
        renderApp('/projects');

        const link = await screen.findByLabelText('Goals');
        expect(link.getAttribute('href')).toBe('/goals');
        fireEvent.click(link);

        expect(await screen.findByText(/No goals yet/)).toBeTruthy();
    });

    it('lists open goals ahead of finished ones, each linking to its page', async () => {
        vi.spyOn(wilson.goals, 'listGoals').mockResolvedValue([
            goal({ id: '1', title: 'Old work', status: 'done' }),
            goal({ id: '2', title: 'Paused work', status: 'paused' }),
            goal({ id: '3', title: 'Current work' }),
        ]);
        renderApp('/goals');

        const rows = await screen.findAllByLabelText(/^goal /);
        expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['goal Paused work', 'goal Current work', 'goal Old work']);
        expect(screen.getByText('Finished')).toBeTruthy();
        expect(within(rows[1]!).getByText('Current work').getAttribute('href')).toBe('/goals/3');
    });

    it('says why goals could not be read', async () => {
        vi.spyOn(wilson.goals, 'listGoals').mockRejectedValue(new Error('the database is down'));
        renderApp('/goals');

        expect(await screen.findByText(/the database is down/)).toBeTruthy();
    });
});

describe('a goal page', () => {
    it('shows the outcome and each card, with a link and what it needs', async () => {
        vi.spyOn(wilson.goals, 'getAGoal').mockResolvedValue(detail());
        renderApp('/goals/3');

        expect(await screen.findByText('People sign in with SSO')).toBeTruthy();
        const flagged = screen.getByLabelText('card 0008');
        expect(within(flagged).getByText('needs you')).toBeTruthy();
        expect(within(flagged).getByText('testing')).toBeTruthy();
        expect(
            within(flagged)
                .getByText(/Add the login page/)
                .getAttribute('href'),
        ).toBe('/projects/ats/cards/0008');
        expect(within(screen.getByLabelText('card 0007')).queryByText('needs you')).toBeNull();
    });

    it('says when it has no cards yet', async () => {
        vi.spyOn(wilson.goals, 'getAGoal').mockResolvedValue(detail({ cards: [] }));
        renderApp('/goals/3');

        expect(await screen.findByText(/No cards yet/)).toBeTruthy();
    });

    it('pauses a goal and shows the new status once read back', async () => {
        const read = vi.spyOn(wilson.goals, 'getAGoal').mockResolvedValue(detail());
        const update = vi.spyOn(wilson.goals, 'updateAGoal').mockResolvedValue(goal({ status: 'paused' }));
        renderApp('/goals/3');

        const pause = await screen.findByRole('button', { name: 'Pause' });
        read.mockResolvedValue(detail({ goal: goal({ status: 'paused' }) }));
        fireEvent.click(pause);

        await waitFor(() => expect(update).toHaveBeenCalledWith('3', { status: 'paused' }));
        expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    });

    it('offers only a reopen on a finished goal', () => {
        expect(STATUS_ACTIONS.done.map(action => action.to)).toEqual(['active']);
        expect(STATUS_ACTIONS.abandoned.map(action => action.to)).toEqual(['active']);
    });

    it('opens the conversation seeing it through', async () => {
        vi.spyOn(wilson.goals, 'getAGoal').mockResolvedValue(detail());
        vi.spyOn(wilson.goals, 'listGoals').mockResolvedValue([goal()]);
        vi.spyOn(wilson.chat, 'getAChatThread').mockResolvedValue({
            thread: { id: '42', title: 'SSO', engine: 'api', createdAt: AT, updatedAt: AT },
            messages: [],
            actions: [],
            questions: [],
        });
        const { router } = renderApp('/goals/3');

        fireEvent.click(await screen.findByRole('button', { name: 'Open conversation' }));

        await waitFor(() => expect(router.state.location.pathname).toBe('/'));
        await waitFor(() => expect(wilson.chat.getAChatThread).toHaveBeenCalledWith('42'));
    });

    it('says when the goal does not exist', async () => {
        vi.spyOn(wilson.goals, 'getAGoal').mockRejectedValue(new Error('goal 3 not found'));
        renderApp('/goals/3');

        expect(await screen.findByText(/goal 3 not found/)).toBeTruthy();
    });
});

describe('the strip above a conversation', () => {
    const thread = {
        thread: { id: '42', title: 'SSO', engine: 'api' as const, createdAt: AT, updatedAt: AT },
        messages: [],
        actions: [],
        questions: [],
    };

    afterEach(() => setActiveThread(undefined));

    it("names the thread's goal and links to it", async () => {
        vi.spyOn(wilson.chat, 'getAChatThread').mockResolvedValue(thread);
        const list = vi.spyOn(wilson.goals, 'listGoals').mockResolvedValue([goal()]);
        setActiveThread('42');
        renderApp('/');

        const strip = await screen.findByLabelText("This thread's goal");
        expect(within(strip).getByText('Add SSO').getAttribute('href')).toBe('/goals/3');
        expect(list).toHaveBeenCalledWith({ threadId: '42' });
    });

    it('shows nothing on a thread without a goal', async () => {
        vi.spyOn(wilson.chat, 'getAChatThread').mockResolvedValue(thread);
        const list = vi.spyOn(wilson.goals, 'listGoals').mockResolvedValue([]);
        setActiveThread('42');
        renderApp('/');

        expect(await screen.findByRole('textbox', { name: 'Message' })).toBeTruthy();
        await waitFor(() => expect(list).toHaveBeenCalled());
        expect(screen.queryByLabelText("This thread's goal")).toBeNull();
    });
});

describe('the goals settings', () => {
    const on = { enabled: true, dailyOutputTokens: 100_000 };

    it('turns watching on, and leaves the ceiling alone', async () => {
        vi.spyOn(wilson.settings, 'getOrchestratorSetting').mockResolvedValue({ ...on, enabled: false });
        const set = vi.spyOn(wilson.settings, 'setOrchestratorSetting').mockResolvedValue(on);
        renderApp('/settings');

        fireEvent.click(await screen.findByRole('switch', { name: /Watch goals/ }));

        await waitFor(() => expect(set).toHaveBeenCalledWith({ enabled: true }));
    });

    it('saves a new ceiling when the field is left, not on each keystroke', async () => {
        vi.spyOn(wilson.settings, 'getOrchestratorSetting').mockResolvedValue(on);
        const set = vi.spyOn(wilson.settings, 'setOrchestratorSetting').mockResolvedValue({ ...on, dailyOutputTokens: 5_000 });
        renderApp('/settings');

        const field = await screen.findByRole('textbox', { name: /Daily ceiling for goals/ });
        fireEvent.change(field, { target: { value: '5000' } });
        expect(set).not.toHaveBeenCalled();
        fireEvent.blur(field);

        await waitFor(() => expect(set).toHaveBeenCalledWith({ dailyOutputTokens: 5_000 }));
    });

    it('says why a ceiling was refused', async () => {
        vi.spyOn(wilson.settings, 'getOrchestratorSetting').mockResolvedValue(on);
        vi.spyOn(wilson.settings, 'setOrchestratorSetting').mockRejectedValue(new Error('the daily ceiling must be at least 1000 output tokens'));
        renderApp('/settings');

        const field = await screen.findByRole('textbox', { name: /Daily ceiling for goals/ });
        fireEvent.change(field, { target: { value: '5' } });
        fireEvent.blur(field);

        expect(await screen.findByText(/must be at least 1000/)).toBeTruthy();
    });
});
