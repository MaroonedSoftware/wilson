import { DateTime } from 'luxon';
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
import type {
    BoardColumns,
    CardSummary,
    CardStageConcurrency,
    ClaudeConfigDirSetting,
    EngineTokenSetting,
    EngineTokenSummary,
    Health,
    NotifyWebhookSetting,
    PollerInterval,
    PollerSetting,
} from '@wilson/sdk';
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
    startedAt: DateTime.fromISO('2026-01-01T00:00:00.000Z'),
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

/** Renders the real app router (root layout + whichever route the path resolves to). */
function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    const queryClient = new QueryClient();
    const { unmount } = render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
    return { router, unmount };
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

/** The chat engine control's `SegmentedControl` measures itself with `ResizeObserver`, which jsdom does not implement. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

beforeEach(() => {
    // Stubbed so the Chat section renders the same way whether or not an API happens to be running on
    // the default port; `chat-engine-setting.test.ts` covers the control itself.
    vi.spyOn(wilson.settings, 'getChatEngineSetting').mockResolvedValue({ engine: 'cli', provider: 'anthropic', model: 'claude-sonnet-5-5' });
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // Stubbed for the same reason as the chat engine above: the local slots control sits beside the
    // concurrency control, and this file's cases are about the controls around it.
    vi.spyOn(wilson.settings, 'getLocalStageSlots').mockResolvedValue({ slots: 8 });
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

        renderApp('/projects');

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

    it("leaves the previous state visible and shows the server's own sentence when a write is refused", async () => {
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
        const setInterval = vi.spyOn(wilson.settings, 'setPollerInterval').mockResolvedValue({ intervalMs: 60_000 } satisfies PollerInterval);

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

    it("reverts to the previous value and shows the server's own sentence when a write is refused", async () => {
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

    it("reverts to the previous value and shows the server's own sentence when a write is refused", async () => {
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

    it("renders the server's own refusal sentence from `details.reason`, not the generic status message", async () => {
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

        expect(await screen.findByText('webhook URL resolves to 169.254.169.254, a link-local address, which is refused')).toBeTruthy();
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

/** The engine token: write-only, so the field is empty on load and empty again after a save. */
describe('the engine token control', () => {
    const load = (source: EngineTokenSetting['source']) => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getClaudeConfigDirSetting').mockResolvedValue({ configDir: null } satisfies ClaudeConfigDirSetting);
        vi.spyOn(wilson.settings, 'getEngineTokenSetting').mockResolvedValue({ source });
        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([]);
        vi.spyOn(wilson.engineTokens, 'listEngineLimits').mockResolvedValue([]);
    };

    it.each([
        ['database', 'the token saved here'],
        ['environment', 'from the environment'],
        ['none', 'No token is set'],
    ] as const)('says where the sign-in comes from when the source is %s', async (source, wording) => {
        load(source);

        renderApp('/settings');

        expect(await screen.findByText(new RegExp(wording))).toBeTruthy();
        // Write-only: nothing is on show until asked for, and then it starts empty.
        expect(screen.queryByLabelText('Engine token')).toBeNull();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: source === 'database' ? 'Replace token' : 'Add token' }));
        });
        expect(((await screen.findByLabelText('Engine token')) as HTMLInputElement).value).toBe('');
    });

    it('groups accounts by how they are used, says which is next, and changes the rotation', async () => {
        load('none');
        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([
            account('limited'),
            account('open', { priority: 1 }),
            account('held', { pooled: false, priority: 7, hosts: ['my-mac'] }),
        ]);
        vi.spyOn(wilson.engineTokens, 'listEngineLimits').mockResolvedValue([
            { account: 'limited', limitType: 'five_hour', resetsAt: DateTime.now().plus({ hours: 1 }) },
            { account: 'worker:vm', limitType: 'seven_day', resetsAt: DateTime.now().plus({ days: 1 }) },
        ]);
        const update = vi.spyOn(wilson.engineTokens, 'updateEngineToken').mockResolvedValue(account('held'));

        renderApp('/settings');

        expect(await screen.findByText('Next engine signs in as open')).toBeTruthy();
        expect(within(await screen.findByLabelText('account limited')).getByText(/5-hour limit, back/)).toBeTruthy();
        expect(within(screen.getByLabelText('account open')).getByText('Next')).toBeTruthy();
        expect(within(screen.getByLabelText('account held')).getByText('my-mac')).toBeTruthy();
        expect(await screen.findByText(/vm's own sign-in: Weekly limit, back/)).toBeTruthy();
        expect(await screen.findByText(/Not used while rotation has accounts/)).toBeTruthy();

        // Joining goes after the accounts already working, whatever priority it last had.
        await act(async () => {
            fireEvent.click(within(screen.getByLabelText('account held')).getByRole('button', { name: 'Add to rotation' }));
        });
        expect(update).toHaveBeenCalledWith('held', { pooled: true, priority: 2 });

        await chooseFromMenu('open', 'Leave rotation');
        expect(update).toHaveBeenCalledWith('open', { pooled: false });
    });

    it('says when no account is free, and when none is in rotation', async () => {
        load('none');
        const saved: EngineTokenSummary = {
            name: 'only',
            provider: 'anthropic',
            kind: 'subscription',
            priority: 0,
            pooled: true,
            createdAt: DateTime.now(),
            updatedAt: DateTime.now(),
            hosts: [],
        };
        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([saved]);
        vi.spyOn(wilson.engineTokens, 'listEngineLimits').mockResolvedValue([
            { account: 'only', limitType: 'seven_day', resetsAt: DateTime.now().plus({ days: 1 }) },
        ]);

        const { unmount } = renderApp('/settings');
        expect(await screen.findByText('Every account in rotation is at its limit')).toBeTruthy();
        unmount();

        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([]);
        renderApp('/settings');
        expect(await screen.findByText('No accounts in rotation')).toBeTruthy();
    });

    const account = (name: string, overrides: Partial<EngineTokenSummary> = {}): EngineTokenSummary => ({
        name,
        provider: 'anthropic',
        kind: 'subscription',
        priority: 0,
        pooled: true,
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
        hosts: [],
        ...overrides,
    });

    const chooseFromMenu = async (name: string, item: string) => {
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: `More actions for ${name}` }));
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole('menuitem', { name: item }));
        });
    };

    const fillIn = async (label: string, value: string) => {
        await act(async () => {
            fireEvent.change(screen.getByLabelText(label), { target: { value } });
        });
    };

    it('adds a subscription at the end of the rotation by default, then closes the form', async () => {
        load('none');
        const put = vi.spyOn(wilson.engineTokens, 'putEngineToken').mockResolvedValue(account('claude-2'));
        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([account('claude-1', { priority: 4 })]);

        renderApp('/settings');

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
        });
        expect(screen.getByText(/claude setup-token/)).toBeTruthy();
        await fillIn('Name', 'claude-2');
        await fillIn('Token', 'sk-ant-oat-secret');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
        });

        expect(put).toHaveBeenCalledWith('claude-2', {
            token: 'sk-ant-oat-secret',
            provider: 'anthropic',
            kind: 'subscription',
            pooled: true,
            priority: 5,
        });
        await waitFor(() => expect(screen.queryByLabelText('add account')).toBeNull());
    });

    it('leaves a new account out of the rotation when asked', async () => {
        load('none');
        const put = vi.spyOn(wilson.engineTokens, 'putEngineToken').mockResolvedValue(account('host-only', { pooled: false }));

        renderApp('/settings');

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
        });
        await fillIn('Name', 'host-only');
        await fillIn('Token', 'sk-ant-oat-secret');
        await act(async () => {
            fireEvent.click(screen.getByLabelText('Add to rotation'));
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
        });

        expect(put).toHaveBeenCalledWith('host-only', { token: 'sk-ant-oat-secret', provider: 'anthropic', kind: 'subscription' });
    });

    it('sends an API key as one, whichever provider it is for', async () => {
        load('none');
        const put = vi.spyOn(wilson.engineTokens, 'putEngineToken').mockResolvedValue(account('codex'));

        renderApp('/settings');

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('combobox', { name: 'Type' }));
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole('option', { name: 'OpenAI API key', hidden: true }));
        });
        await fillIn('Name', 'codex');
        await fillIn('Token', 'sk-key');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
        });

        expect(put).toHaveBeenCalledWith('codex', expect.objectContaining({ provider: 'openai', kind: 'api_key' }));
    });

    it('refuses a name already saved, rather than replacing that token', async () => {
        load('none');
        const put = vi.spyOn(wilson.engineTokens, 'putEngineToken');
        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([account('claude-1')]);

        renderApp('/settings');

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
        });
        await fillIn('Name', 'claude-1');
        await fillIn('Token', 'sk-ant-oat-secret');

        expect(screen.getByText(/That name is taken/)).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Save account' }) as HTMLButtonElement).disabled).toBe(true);
        expect(put).not.toHaveBeenCalled();
    });

    it('keeps the form and what was typed when the server refuses', async () => {
        load('none');
        vi.spyOn(wilson.engineTokens, 'putEngineToken').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'bad name' }, new Headers()),
        );

        renderApp('/settings');

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
        });
        await fillIn('Name', 'Bad Name');
        await fillIn('Token', 'sk-ant-oat-secret');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
        });

        await waitFor(() => expect(within(screen.getByLabelText('add account')).getByText(/bad name/)).toBeTruthy());
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Bad Name');
    });

    it('moves an account, sending only the priorities that change, and cannot move past either end', async () => {
        load('none');
        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([account('a'), account('b'), account('c')]);
        const update = vi.spyOn(wilson.engineTokens, 'updateEngineToken').mockResolvedValue(account('a'));

        renderApp('/settings');

        expect(((await screen.findByRole('button', { name: 'Move a up' })) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Move c down' }) as HTMLButtonElement).disabled).toBe(true);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Move c up' }));
        });

        await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
        expect(update).toHaveBeenCalledWith('c', { priority: 1 });
        expect(update).toHaveBeenCalledWith('b', { priority: 2 });
    });

    it('offers no ordering to an account outside the rotation', async () => {
        load('none');
        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([account('held', { pooled: false })]);

        renderApp('/settings');

        await screen.findByLabelText('account held');
        expect(screen.queryByRole('button', { name: 'Move held up' })).toBeNull();
    });

    it('replaces only the token, under the same name', async () => {
        load('none');
        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([account('claude-1')]);
        const put = vi.spyOn(wilson.engineTokens, 'putEngineToken').mockResolvedValue(account('claude-1'));

        renderApp('/settings');

        await chooseFromMenu('claude-1', 'Replace token');
        const input = (await screen.findByLabelText('New token for claude-1')) as HTMLInputElement;
        expect(input.value).toBe('');
        await act(async () => {
            fireEvent.change(input, { target: { value: 'sk-ant-oat-new' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(input));
        });

        expect(put).toHaveBeenCalledWith('claude-1', { token: 'sk-ant-oat-new' });
        await waitFor(() => expect(screen.queryByLabelText('New token for claude-1')).toBeNull());
    });

    it('asks before removing an account, naming the hosts that lose it', async () => {
        load('none');
        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([account('claude-1', { hosts: ['my-mac'] })]);
        const remove = vi.spyOn(wilson.engineTokens, 'removeEngineToken').mockResolvedValue(undefined);

        renderApp('/settings');

        await chooseFromMenu('claude-1', 'Remove');
        expect(await screen.findByText(/my-mac goes back to the machine's own sign-in/)).toBeTruthy();
        expect(remove).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Remove account' }));
        });
        expect(remove).toHaveBeenCalledWith('claude-1');
    });

    it('keeps an account when the removal is called off', async () => {
        load('none');
        vi.spyOn(wilson.engineTokens, 'listEngineTokens').mockResolvedValue([account('claude-1', { hosts: ['my-mac'] })]);
        const remove = vi.spyOn(wilson.engineTokens, 'removeEngineToken').mockResolvedValue(undefined);

        renderApp('/settings');

        await chooseFromMenu('claude-1', 'Remove');
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Keep it' }));
        });

        expect(screen.queryByText(/my-mac goes back/)).toBeNull();
        expect(remove).not.toHaveBeenCalled();
    });

    it('sends what was typed, then closes and empties the field', async () => {
        load('none');
        const setToken = vi.spyOn(wilson.settings, 'setEngineTokenSetting').mockResolvedValue({ source: 'database' });

        renderApp('/settings');

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Add token' }));
        });
        const input = (await screen.findByLabelText('Engine token')) as HTMLInputElement;
        await act(async () => {
            fireEvent.change(input, { target: { value: 'sk-ant-oat-secret' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(input));
        });

        expect(setToken).toHaveBeenCalledWith({ token: 'sk-ant-oat-secret' });
        await waitFor(() => expect(screen.queryByLabelText('Engine token')).toBeNull());
        expect(await screen.findByText(/the token saved here/)).toBeTruthy();
    });

    it('offers Remove only for a saved token, asks first, and sends null', async () => {
        load('database');
        const setToken = vi.spyOn(wilson.settings, 'setEngineTokenSetting').mockResolvedValue({ source: 'none' });

        renderApp('/settings');

        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
        });
        expect(setToken).not.toHaveBeenCalled();
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Remove token' }));
        });

        expect(setToken).toHaveBeenCalledWith({ token: null });
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull());
    });
});

/**
 * Card 0141: the "Engine credentials" field — `CLAUDE_CONFIG_DIR`, resolved server-side and pointed
 * at by `subscriptionEnv`. Modelled on the notification webhook control's own tests: a single
 * `TextInput` + Save, no client-side format check (the server checks only that the path is
 * absolute), and — per the component's own doc — a refusal does not revert the typed draft.
 */
describe('the claude config directory control', () => {
    it('shows the directory the API reports on load, not an assumed default', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getClaudeConfigDirSetting').mockResolvedValue({
            configDir: '/home/operator/.claude-wilson',
        } satisfies ClaudeConfigDirSetting);

        renderApp('/settings');

        const input = (await screen.findByLabelText('Claude config directory')) as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe('/home/operator/.claude-wilson'));
    });

    it('shows an empty field, not a placeholder value, when the setting is unset', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getClaudeConfigDirSetting').mockResolvedValue({ configDir: null } satisfies ClaudeConfigDirSetting);

        renderApp('/settings');

        const input = (await screen.findByLabelText('Claude config directory')) as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe(''));
    });

    it('trims a typed path and sends it, then renders what the server returns from the write, not the value typed', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getClaudeConfigDirSetting').mockResolvedValue({ configDir: null } satisfies ClaudeConfigDirSetting);
        // The server can round-trip a different value than requested — same principle every other
        // control's write test proves — so the UI must render what came back, not what was typed.
        const setConfigDir = vi.spyOn(wilson.settings, 'setClaudeConfigDirSetting').mockResolvedValue({
            configDir: '/home/operator/.claude-wilson-normalised',
        } satisfies ClaudeConfigDirSetting);

        renderApp('/settings');

        const input = (await screen.findByLabelText('Claude config directory')) as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe(''));

        await act(async () => {
            fireEvent.change(input, { target: { value: '  /home/operator/.claude-wilson  ' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(input));
        });

        expect(setConfigDir).toHaveBeenCalledWith({ configDir: '/home/operator/.claude-wilson' });
        await waitFor(() => expect(input.value).toBe('/home/operator/.claude-wilson-normalised'));
    });

    it('sends null, not an empty string, when the field is cleared', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getClaudeConfigDirSetting').mockResolvedValue({
            configDir: '/home/operator/.claude-wilson',
        } satisfies ClaudeConfigDirSetting);
        const setConfigDir = vi
            .spyOn(wilson.settings, 'setClaudeConfigDirSetting')
            .mockResolvedValue({ configDir: null } satisfies ClaudeConfigDirSetting);

        renderApp('/settings');

        const input = (await screen.findByLabelText('Claude config directory')) as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe('/home/operator/.claude-wilson'));

        await act(async () => {
            fireEvent.change(input, { target: { value: '   ' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(input));
        });

        expect(setConfigDir).toHaveBeenCalledWith({ configDir: null });
        await waitFor(() => expect(input.value).toBe(''));
    });

    it("shows the server's own refusal sentence and keeps the typed draft visible, unlike the numeric controls", async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getClaudeConfigDirSetting').mockResolvedValue({
            configDir: '/home/operator/.claude-wilson',
        } satisfies ClaudeConfigDirSetting);
        vi.spyOn(wilson.settings, 'setClaudeConfigDirSetting').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                {
                    statusCode: 400,
                    message: 'Bad Request',
                    details: { reason: 'claude config directory must be an absolute path, got "relative/dir"' },
                },
                new Headers(),
            ),
        );

        renderApp('/settings');

        const input = (await screen.findByLabelText('Claude config directory')) as HTMLInputElement;
        await waitFor(() => expect(input.value).toBe('/home/operator/.claude-wilson'));

        await act(async () => {
            fireEvent.change(input, { target: { value: 'relative/dir' } });
        });
        await act(async () => {
            fireEvent.click(saveButtonFor(input));
        });

        expect(await screen.findByText('claude config directory must be an absolute path, got "relative/dir"')).toBeTruthy();
        expect(screen.queryByText('Bad Request')).toBeNull();
        // Unlike the poll interval / concurrency controls, the rejected draft is not discarded —
        // the component's own doc says a path typo is easy to mistype twice in a row.
        expect(input.value).toBe('relative/dir');
        expect(await screen.findByText('Still saved: /home/operator/.claude-wilson')).toBeTruthy();
    });

    it('describes the authentication requirement and that a change only applies to stages started afterwards', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getClaudeConfigDirSetting').mockResolvedValue({ configDir: null } satisfies ClaudeConfigDirSetting);

        renderApp('/settings');

        await screen.findByLabelText('Claude config directory');
        // Constraint: "The field needs a description saying the directory must already be
        // authenticated, not just a label" and "say so in the field's description rather than
        // implying it takes effect immediately".
        expect(screen.getByText(/must already be authenticated/i)).toBeTruthy();
        expect(screen.getByText(/applies to stages started afterwards/)).toBeTruthy();
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

        expect(await screen.findByText('/deploy/code')).toBeTruthy();
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

describe('the GitHub App control', () => {
    const load = (appId: string | null, keyInstalled: boolean) => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });
        vi.spyOn(wilson.settings, 'getPollerInterval').mockResolvedValue({ intervalMs: 30_000 } satisfies PollerInterval);
        vi.spyOn(wilson.settings, 'getCardStageConcurrency').mockResolvedValue({ concurrency: 3 } satisfies CardStageConcurrency);
        vi.spyOn(wilson.settings, 'getClaudeConfigDirSetting').mockResolvedValue({ configDir: null } satisfies ClaudeConfigDirSetting);
        vi.spyOn(wilson.settings, 'getGithubAppSetting').mockResolvedValue({ appId, keyInstalled });
    };

    it('says where the key goes while it is missing', async () => {
        load(null, false);

        renderApp('/settings');

        expect(await screen.findByText(/Private key not found/)).toBeTruthy();
    });

    it('saves a typed id and shows what the server stored', async () => {
        load(null, true);
        const set = vi.spyOn(wilson.settings, 'setGithubAppSetting').mockResolvedValue({ appId: '123456', keyInstalled: true });

        renderApp('/settings');

        const input = (await screen.findByLabelText('GitHub App ID')) as HTMLInputElement;
        fireEvent.change(input, { target: { value: ' 123456 ' } });
        const save = input.closest('.mantine-Stack-root')!.querySelector('button') as HTMLButtonElement;
        fireEvent.click(save);

        await waitFor(() => expect(set).toHaveBeenCalledWith({ appId: '123456' }));
        await waitFor(() => expect(input.value).toBe('123456'));
    });
});
