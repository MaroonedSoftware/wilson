// @vitest-environment jsdom
//
// Card 0114: the settings route (auto-mode toggle + read-only deployment facts) did not exist
// before this card — `apps/web/src/routes/settings.tsx` and the settings link in
// `apps/web/src/routes/__root.tsx` are both new. These tests render the real route tree (so the
// route registration and the header link are exercised as written, not re-implemented here) with
// `wilson`'s SDK calls mocked, the same way the app really talks to the API.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead, as
// `feed.mount.test.ts` already does for hook tests.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { BoardColumns, CardSummary, CardStageConcurrency, Health, NotifyWebhookSetting, PollerInterval, PollerSetting } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { routeTree } from '#src/routeTree.gen.js';

const emptyColumns: BoardColumns = { stages: [], nonStages: [] };
const emptyCards: CardSummary[] = [];

/**
 * The root layout (`__root.tsx`) mounts `useCardFeed` on every route, including `/settings` —
 * jsdom has no `EventSource`, so without a stand-in every render in this file throws before the
 * route under test ever renders. Not the behaviour under test; only here so the shell survives.
 */
class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

const baseHealth: Health = {
    ok: true,
    project: 'wilson',
    head: 'abc1234',
    startedAt: '2026-01-01T00:00:00.000Z',
    boardRoot: '/deploy/board',
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

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

/**
 * Card 0115 puts two `NumberInput` + Save controls on the same page — scoping to the input's own
 * `Stack` (each control's own doc: a local `draft` state, a `Save` button below it) finds the right
 * button regardless of which control it belongs to or how many others are on the page.
 */
function saveButtonFor(input: HTMLElement): HTMLElement {
    const container = input.closest('.mantine-Stack-root') as HTMLElement;
    return within(container).getByRole('button', { name: 'Save' });
}

beforeEach(() => {
    vi.spyOn(wilson.board, 'listBoardColumns').mockResolvedValue(emptyColumns);
    vi.spyOn(wilson.board, 'listCards').mockResolvedValue(emptyCards);
    vi.spyOn(wilson.health, 'getHealth').mockResolvedValue(baseHealth);
    vi.stubGlobal('EventSource', FakeEventSource);

    // jsdom does not implement matchMedia; MantineProvider reads it (colour-scheme detection) on
    // mount regardless of what this test renders, so every case needs the stub, not just ones
    // that touch theming.
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
});

afterEach(() => {
    // `apps/web/vitest.config.ts` does not set `test.globals: true`, so `@testing-library/react`'s
    // own auto-cleanup (which only registers when it finds `afterEach` on the global object) never
    // fires — without this, each test's `render()` piles onto the previous test's DOM instead of
    // replacing it, and later tests observe stale elements from earlier ones.
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the board links to settings', () => {
    it('is reachable from the board by clicking, not just by knowing the URL', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });

        renderApp('/');

        const link = await screen.findByLabelText('Settings');
        expect(link.getAttribute('href')).toBe('/settings');

        fireEvent.click(link);

        expect(await screen.findByText('Auto-mode')).toBeTruthy();
    });
});

describe('the auto-mode toggle', () => {
    it('shows the poller state the API reports on load, not an assumed default', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: true });

        renderApp('/settings');

        const toggle = (await screen.findByRole('switch')) as HTMLInputElement;
        expect(toggle.checked).toBe(true);
    });

    it('renders what the server returns from the write, not the value clicked', async () => {
        // The server can refuse a write yet still answer 200 with the setting unchanged (an env
        // override pinning the poller off, for instance) — the plan's own example of why the UI
        // must never assume a click took. `setPollerSetting` resolving to `enabled: false` after a
        // click that requested `true` is exactly that case.
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        const setPoller = vi.spyOn(wilson.settings, 'setPollerSetting').mockResolvedValue({ enabled: false } satisfies PollerSetting);

        renderApp('/settings');

        const toggle = (await screen.findByRole('switch')) as HTMLInputElement;
        expect(toggle.checked).toBe(false);

        await act(async () => {
            fireEvent.click(toggle);
        });

        expect(setPoller).toHaveBeenCalledWith({ enabled: true });
        await waitFor(() => expect(toggle.checked).toBe(false));
    });

    it('leaves the previous state visible and shows the server\'s own sentence when a write is refused', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'setPollerSetting').mockRejectedValue(
            new SdkError(409, 'Conflict', { statusCode: 409, message: 'poller is pinned off by POLLER_ENABLED=false' }, new Headers()),
        );

        renderApp('/settings');

        const toggle = (await screen.findByRole('switch')) as HTMLInputElement;
        expect(toggle.checked).toBe(false);

        await act(async () => {
            fireEvent.click(toggle);
        });

        expect(await screen.findByText('poller is pinned off by POLLER_ENABLED=false')).toBeTruthy();
        // "Request failed" (the SDK's generic `${status} ${statusText}`) would be a regression per
        // the plan — the server's own sentence must be what renders.
        expect(screen.queryByText('409 Conflict')).toBeNull();
        expect(toggle.checked).toBe(false);
    });
});

describe('the poll interval control', () => {
    it('shows the interval the API reports on load, not an assumed default', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 45_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);

        renderApp('/settings');

        const input = (await screen.findByLabelText('Poll interval (ms)')) as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe('45000'));
    });

    it('saves a typed value and renders what the server returns from the write, not the value typed', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        // The server can round-trip a different value than requested — same principle the
        // auto-mode toggle's own write test proves — so the UI must render what came back, not
        // what was typed.
        const setInterval = vi
            .spyOn(wilson.settings, 'setPollerInterval')
            .mockResolvedValue({ intervalMs: 60_000 } satisfies PollerInterval);

        renderApp('/settings');

        const input = (await screen.findByLabelText('Poll interval (ms)')) as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe('30000'));

        await act(async () => {
            fireEvent.change(input, { target: { value: '90000' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(input));
        });

        expect(setInterval).toHaveBeenCalledWith({ intervalMs: 90_000 });
        await waitFor(() => expect(input.value).toBe('60000'));
    });

    it('reverts to the previous value and shows the server\'s own sentence when a write is refused', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'setPollerInterval').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'poller interval must be between 5000 and 300000 ms' }, new Headers()),
        );

        renderApp('/settings');

        const input = (await screen.findByLabelText('Poll interval (ms)')) as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe('30000'));

        await act(async () => {
            fireEvent.change(input, { target: { value: '1000' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(input));
        });

        expect(await screen.findByText('poller interval must be between 5000 and 300000 ms')).toBeTruthy();
        expect(input.value).toBe('30000'); // the rejected draft is gone; the last-known-good value is back
    });
});

describe('the card stage concurrency control', () => {
    it('shows the concurrency the API reports on load, not an assumed default', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 5 } satisfies CardStageConcurrency);

        renderApp('/settings');

        const input = (await screen.findByLabelText('Concurrent stages')) as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe('5'));
    });

    it('reverts to the previous value and shows the server\'s own sentence when a write is refused', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'setCardStageConcurrency').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'card stage concurrency must be between 1 and 8' }, new Headers()),
        );

        renderApp('/settings');

        const input = (await screen.findByLabelText('Concurrent stages')) as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe('3'));

        await act(async () => {
            fireEvent.change(input, { target: { value: '20' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(input));
        });

        expect(await screen.findByText('card stage concurrency must be between 1 and 8')).toBeTruthy();
        expect(input.value).toBe('3'); // the rejected draft is gone; the last-known-good value is back
    });
});

describe('the notification webhook control', () => {
    it('shows the webhook and base URL the API reports on load, not assumed defaults', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getNotifyWebhookSetting').mockResolvedValue({
            webhookUrl: 'https://hooks.example.com/wilson',
            baseUrl: 'https://board.example.com',
        } satisfies NotifyWebhookSetting);

        renderApp('/settings');

        const webhookInput = (await screen.findByLabelText('Webhook URL')) as HTMLInputElement;
        const baseUrlInput = (await screen.findByLabelText('Base URL')) as HTMLInputElement;
        await waitFor(() => expect(webhookInput.value).toBe('https://hooks.example.com/wilson'));
        expect(baseUrlInput.value).toBe('https://board.example.com');
    });

    it('saves both fields together, converts a blank field to null, and renders what the server returns', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getNotifyWebhookSetting').mockResolvedValue({
            webhookUrl: null,
            baseUrl: null,
        } satisfies NotifyWebhookSetting);
        // The server can round-trip a different value than requested (trailing slash normalised,
        // say) — same principle the other controls' write tests prove — so the UI must render what
        // came back, not what was typed.
        const setWebhook = vi.spyOn(wilson.settings, 'setNotifyWebhookSetting').mockResolvedValue({
            webhookUrl: 'https://hooks.example.com/normalised',
            baseUrl: null,
        } satisfies NotifyWebhookSetting);

        renderApp('/settings');

        const webhookInput = (await screen.findByLabelText('Webhook URL')) as HTMLInputElement;
        const baseUrlInput = (await screen.findByLabelText('Base URL')) as HTMLInputElement;
        await waitFor(() => expect(webhookInput.value).toBe(''));

        await act(async () => {
            fireEvent.change(webhookInput, { target: { value: '  https://hooks.example.com/wilson  ' } });
        });
        await act(async () => {
            fireEvent.change(baseUrlInput, { target: { value: '   ' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(webhookInput));
        });

        // Leading/trailing whitespace trimmed, and an all-whitespace base URL sent as `null` — the
        // one-`PUT`-for-both-fields shape `SetNotifyWebhookSettingRequest` requires.
        expect(setWebhook).toHaveBeenCalledWith({ webhookUrl: 'https://hooks.example.com/wilson', baseUrl: null });
        await waitFor(() => expect(webhookInput.value).toBe('https://hooks.example.com/normalised'));
        expect(baseUrlInput.value).toBe('');
    });

    it('saves the base URL exactly as typed, without any client-side format check', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getNotifyWebhookSetting').mockResolvedValue({
            webhookUrl: 'https://hooks.example.com/wilson',
            baseUrl: null,
        } satisfies NotifyWebhookSetting);
        const setWebhook = vi.spyOn(wilson.settings, 'setNotifyWebhookSetting').mockResolvedValue({
            webhookUrl: 'https://hooks.example.com/wilson',
            baseUrl: 'not-a-url-at-all',
        } satisfies NotifyWebhookSetting);

        renderApp('/settings');

        const webhookInput = (await screen.findByLabelText('Webhook URL')) as HTMLInputElement;
        const baseUrlInput = (await screen.findByLabelText('Base URL')) as HTMLInputElement;
        await waitFor(() => expect(webhookInput.value).toBe('https://hooks.example.com/wilson'));

        // Not https, not even a well-formed URL — the base URL carries none of the webhook's
        // checks, so nothing in this component should reject it or alter it before sending.
        await act(async () => {
            fireEvent.change(baseUrlInput, { target: { value: 'not-a-url-at-all' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(baseUrlInput));
        });

        expect(setWebhook).toHaveBeenCalledWith({ webhookUrl: 'https://hooks.example.com/wilson', baseUrl: 'not-a-url-at-all' });
        await waitFor(() => expect(baseUrlInput.value).toBe('not-a-url-at-all'));
    });

    it('renders the server\'s own refusal sentence from `details.reason`, not the generic status message', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getNotifyWebhookSetting').mockResolvedValue({
            webhookUrl: 'https://hooks.example.com/wilson',
            baseUrl: null,
        } satisfies NotifyWebhookSetting);
        // `errorMiddleware`'s body pins `message` to the generic HTTP status text and carries the
        // actual refusal in `details.reason` (`httpError(...).withDetails({ reason })`) — the shape
        // `checkWebhookDestination`'s refusal actually takes. `message` here is deliberately generic
        // and distinct from `details.reason` so the test fails unless the reason wins.
        vi.spyOn(wilson.settings, 'setNotifyWebhookSetting').mockRejectedValue(
            new SdkError(
                422,
                'Unprocessable Entity',
                {
                    statusCode: 422,
                    message: 'Unprocessable Entity',
                    details: { reason: 'webhook URL resolves to 169.254.169.254, a link-local address, which is refused' },
                },
                new Headers(),
            ),
        );

        renderApp('/settings');

        const webhookInput = (await screen.findByLabelText('Webhook URL')) as HTMLInputElement;
        await waitFor(() => expect(webhookInput.value).toBe('https://hooks.example.com/wilson'));

        await act(async () => {
            fireEvent.change(webhookInput, { target: { value: 'https://metadata.internal/hook' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(webhookInput));
        });

        expect(
            await screen.findByText('webhook URL resolves to 169.254.169.254, a link-local address, which is refused'),
        ).toBeTruthy();
        expect(screen.queryByText('Unprocessable Entity')).toBeNull();

        // The plan's own constraint: a refused write keeps the previous value visible — but unlike
        // the numeric controls, the typed draft that got refused is not silently discarded either,
        // since retyping a webhook URL blind is exactly what the doc above says this avoids.
        expect(webhookInput.value).toBe('https://metadata.internal/hook');
        expect(await screen.findByText('Still saved: https://hooks.example.com/wilson')).toBeTruthy();
    });

    it('explains that the two fields carry different risk, not just what they are called', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getNotifyWebhookSetting').mockResolvedValue({
            webhookUrl: null,
            baseUrl: null,
        } satisfies NotifyWebhookSetting);

        renderApp('/settings');

        await screen.findByLabelText('Webhook URL');
        // The webhook is called out as a destination the server checks; the base URL as a payload
        // value nothing here fetches — the plan's "do not imply the base URL is validated".
        expect(screen.getByText(/destination this daemon sends a request to, so the/)).toBeTruthy();
        expect(screen.getByText(/nothing here ever fetches it, so it is saved exactly as typed/)).toBeTruthy();
    });
});

describe('deployment facts', () => {
    it('renders the roots read-only and says why, rather than leaving an edit control to hunt for', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        // Mocked like every other test in this file: left unmocked, this hits the real API base
        // (`http://localhost:13100` by default), and whether it resolves before the assertion below
        // runs is a race the test must not depend on either way.
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);

        renderApp('/settings');

        expect(await screen.findByText('/deploy/board')).toBeTruthy();
        expect(screen.getByText('/deploy/code')).toBeTruthy();
        expect(screen.getByText('/deploy/worktrees')).toBeTruthy();
        expect(screen.getByText(/environment-only/)).toBeTruthy();

        // Read-only: nothing in the Deployment section offers to edit the roots. Scoped to that
        // section specifically, not the whole page — card 0115's "Poll interval"/"Concurrent
        // stages" controls sit in their own sections above and are genuinely editable `NumberInput`s
        // (which Mantine renders as `<input type="text" inputmode="decimal">`); this test is about
        // the deployment facts, not a claim that no other control on the page takes input.
        const deploymentSection = screen.getByText('Deployment').closest('.mantine-Paper-root') as HTMLElement;
        expect(within(deploymentSection).queryAllByRole('textbox')).toHaveLength(0);
    });
});
