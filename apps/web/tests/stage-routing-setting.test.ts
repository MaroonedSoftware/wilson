// @vitest-environment jsdom
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { Health, StageRouting } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { routeTree } from '#src/routeTree.gen.js';

/**
 * The settings page's Stage routing section (`StageRoutingControl`, `settings.tsx`): one row per stage
 * that reaches a model, each saved on its own. Like every other control on the page, it shows what
 * the server kept, never only what was picked.
 */

const baseHealth: Health = {
    ok: true,
    project: 'wilson',
    head: 'abc1234',
    startedAt: DateTime.fromISO('2026-01-01T00:00:00.000Z'),
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

const planning: StageRouting = { stage: 'planning', mode: 'manual', adapter: 'api', provider: 'anthropic', model: 'claude-opus-5' };
const ready: StageRouting = { stage: 'ready', mode: 'manual', adapter: 'api', provider: 'anthropic' };
const backlog: StageRouting = { stage: 'backlog', mode: 'manual', adapter: 'api', provider: 'anthropic', model: 'claude-sonnet-5' };
const implementing: StageRouting = { stage: 'implementing', mode: 'agent', adapter: 'cli', provider: 'anthropic', model: 'claude-sonnet-5' };

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

beforeEach(() => {
    vi.spyOn(wilson.health, 'getHealth').mockResolvedValue(baseHealth);
    vi.spyOn(wilson.stages, 'listStageRouting').mockResolvedValue([planning, backlog, implementing, ready]);
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

describe('the warning about review and implementing sharing a provider', () => {
    const review: StageRouting = { stage: 'review', mode: 'agent', adapter: 'cli', provider: 'anthropic', model: 'claude' };

    it('names the provider when they share one, and says nothing otherwise', async () => {
        vi.spyOn(wilson.stages, 'listStageRouting').mockResolvedValue([implementing, review]);
        renderSettings();
        expect(await screen.findByText('Review and implementing share a provider')).toBeTruthy();
    });

    it('stays quiet when they differ, or when a project has no review lane', async () => {
        vi.spyOn(wilson.stages, 'listStageRouting').mockResolvedValue([implementing, { ...review, adapter: 'api', provider: 'openai' }]);
        renderSettings();
        await screen.findByLabelText('implementing model');
        expect(screen.queryByText('Review and implementing share a provider')).toBeNull();
    });
});

describe('the stage routing control', () => {
    it('offers ready a model only, falling back to the chat engine', async () => {
        renderSettings();
        await screen.findByLabelText('implementing model');

        const model = screen.getByLabelText('ready model') as HTMLInputElement;
        expect(model.value).toBe('');
        expect(model.placeholder).toContain('chat engine');
        expect(screen.queryByLabelText('ready provider')).toBeNull();
        expect(screen.queryByLabelText('ready adapter')).toBeNull();
    });

    it('lists the stages that reach a model, and no others', async () => {
        renderSettings();

        expect(((await screen.findByLabelText('implementing model')) as HTMLInputElement).value).toBe('claude-sonnet-5');
        expect(screen.getByLabelText('planning model')).toBeTruthy();
        expect(screen.queryByLabelText('backlog model')).toBeNull();
    });

    it('offers no provider where the engine always runs Claude', async () => {
        renderSettings();
        await screen.findByLabelText('implementing model');

        expect(screen.queryByLabelText('implementing provider')).toBeNull();
        expect(screen.queryByLabelText('planning provider')).toBeNull();
        expect(screen.queryByLabelText('planning adapter')).toBeNull();
    });

    it('saves one stage and renders what the server kept', async () => {
        const kept = { ...implementing, model: 'claude-haiku-5-5' };
        const set = vi.spyOn(wilson.stages, 'setStageRouting').mockResolvedValue(kept);
        const list = vi.spyOn(wilson.stages, 'listStageRouting').mockResolvedValue([planning, implementing]);
        renderSettings();
        const model = (await screen.findByLabelText('implementing model')) as HTMLInputElement;
        const row = model.closest('.mantine-Stack-root') as HTMLElement;

        list.mockResolvedValue([planning, kept]);
        fireEvent.change(model, { target: { value: 'claude-haiku-5-5' } });
        fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(set).toHaveBeenCalledWith('implementing', { adapter: 'cli', provider: 'anthropic', model: 'claude-haiku-5-5' }));
        await waitFor(() => expect((within(row).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
    });

    it('shows why a save was refused', async () => {
        vi.spyOn(wilson.stages, 'setStageRouting').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'a model is required' } }, new Headers()),
        );
        renderSettings();
        const model = (await screen.findByLabelText('implementing model')) as HTMLInputElement;
        const row = model.closest('.mantine-Stack-root') as HTMLElement;

        fireEvent.change(model, { target: { value: 'nope' } });
        fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

        expect(await within(row).findByText(/a model is required/)).toBeTruthy();
    });
});
