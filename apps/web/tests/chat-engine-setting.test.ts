// @vitest-environment jsdom
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { ChatEngineSetting, Health } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { routeTree } from '#src/routeTree.gen.js';

/**
 * The settings page's Chat section (`ChatEngineControl`, `settings.tsx`): which engine new chats run
 * on and the model they use. Like every other control on the page, it shows what the server kept,
 * never only what was picked.
 */

const baseHealth: Health = {
    ok: true,
    project: 'wilson',
    head: 'abc1234',
    startedAt: DateTime.fromISO('2026-01-01T00:00:00.000Z'),
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

const cliDefault: ChatEngineSetting = { engine: 'cli', provider: 'anthropic', model: 'claude-sonnet-5-5' };

class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

/** `SegmentedControl` measures itself with `ResizeObserver`, which jsdom does not implement. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderSettings() {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/settings'] }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
}

/** The Chat section's own `Paper`, so its Save and Model are not confused with another control's. */
const chatSection = async () => (await screen.findByRole('heading', { name: 'Chat' })).closest('.mantine-Paper-root') as HTMLElement;

beforeEach(() => {
    vi.spyOn(wilson.health, 'getHealth').mockResolvedValue(baseHealth);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
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

describe('the chat engine control', () => {
    it('shows the engine and model the API reports, with no provider to pick for the subscription engine', async () => {
        vi.spyOn(wilson.settings, 'getChatEngineSetting').mockResolvedValue(cliDefault);
        renderSettings();
        const section = await chatSection();

        expect(((await within(section).findByLabelText('Model')) as HTMLInputElement).value).toBe('claude-sonnet-5-5');
        expect(within(section).getByText(/No API key needed/)).toBeTruthy();
        expect(within(section).queryByLabelText('Provider')).toBeNull();
        expect((within(section).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('saves a switch to the AI SDK and renders what the server kept', async () => {
        vi.spyOn(wilson.settings, 'getChatEngineSetting').mockResolvedValue(cliDefault);
        const set = vi
            .spyOn(wilson.settings, 'setChatEngineSetting')
            .mockResolvedValue({ engine: 'api', provider: 'anthropic', model: 'claude-opus-5-5' });
        renderSettings();
        const section = await chatSection();
        await within(section).findByLabelText('Model');

        fireEvent.click(within(section).getByText('AI SDK'));
        expect(within(section).getByText(/billed per token/)).toBeTruthy();
        expect(within(section).getByLabelText('Provider')).toBeTruthy();
        fireEvent.change(within(section).getByLabelText('Model'), { target: { value: 'claude-opus-5-5' } });
        fireEvent.click(within(section).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(set).toHaveBeenCalledWith({ engine: 'api', provider: 'anthropic', model: 'claude-opus-5-5' }));
        await waitFor(() => expect((within(section).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
    });

    it("shows the server's own refusal", async () => {
        vi.spyOn(wilson.settings, 'getChatEngineSetting').mockResolvedValue(cliDefault);
        vi.spyOn(wilson.settings, 'setChatEngineSetting').mockRejectedValue(
            new SdkError(400, 'Bad Request', { message: 'Bad Request', details: { reason: 'a model is required' } }),
        );
        renderSettings();
        const section = await chatSection();

        fireEvent.change(await within(section).findByLabelText('Model'), { target: { value: ' ' } });
        fireEvent.click(within(section).getByRole('button', { name: 'Save' }));

        expect(await within(section).findByText('a model is required')).toBeTruthy();
    });
});
