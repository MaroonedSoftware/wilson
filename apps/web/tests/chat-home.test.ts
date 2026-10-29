// @vitest-environment jsdom
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, HealthClient, ProjectsClient } from '@wilson/sdk';
import type { ChatThread, ChatThreadDetail, Health } from '@wilson/sdk';
import { setActiveThread } from '#src/lib/chat.js';
import { routeTree } from '#src/routeTree.gen.js';

/**
 * `/` is the chat, the whole page (`routes/index.tsx`), as ats's home page is: threads down the side,
 * the conversation in the middle, and a new chat opening on a prompt with suggestions to start from.
 */

const at = (iso: string) => DateTime.fromISO(iso);

const baseHealth: Health = {
    ok: true,
    project: 'demo',
    head: 'abc1234',
    startedAt: at('2026-01-01T00:00:00.000Z'),
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

const thread = (id: string, title: string): ChatThread => ({
    id,
    title,
    engine: 'cli',
    createdAt: at('2026-10-29T10:00:00Z'),
    updatedAt: at('2026-10-29T10:00:00Z'),
});

const detail = (of: ChatThread, content: string): ChatThreadDetail => ({
    thread: of,
    messages: [{ seq: 1, role: 'user', content, operations: [], createdAt: at('2026-10-29T10:00:01Z') }],
    actions: [],
});

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

function renderHome() {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
}

beforeEach(() => {
    setActiveThread(undefined);
    vi.spyOn(HealthClient.prototype, 'getHealth').mockResolvedValue(baseHealth);
    vi.spyOn(ProjectsClient.prototype, 'listProjects').mockResolvedValue([{ name: 'demo' }]);
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
    Element.prototype.scrollTo = vi.fn();
    Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener: vi.fn(), removeEventListener: vi.fn() } });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the chat home page', () => {
    it('opens on a new chat with suggestions, and offers no second way into the chat from the header', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([]);
        renderHome();

        expect(await screen.findByText('What should we do?')).toBeTruthy();
        expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
        expect(screen.getByText('What is waiting on me?')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull();
    });

    it('sends a suggestion as the first message of a new thread', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([]);
        vi.spyOn(ChatClient.prototype, 'startAChatThread').mockResolvedValue(thread('7', 'New chat'));
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail(thread('7', 'What is waiting on me?'), 'What is waiting on me?'));
        const send = vi.spyOn(ChatClient.prototype, 'sendAChatMessage').mockReturnValue(new Promise(() => {}));
        renderHome();

        fireEvent.click(await screen.findByText('What is waiting on me?'));

        await waitFor(() => expect(send).toHaveBeenCalledWith('7', { text: 'What is waiting on me?' }));
    });

    it('lists threads down the side and opens one on click', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([thread('7', 'Board triage'), thread('8', 'Release 0008')]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail(thread('8', 'Release 0008'), 'Release 0008 please'));
        renderHome();

        fireEvent.click(await screen.findByText('Release 0008'));

        expect(await screen.findByText('Release 0008 please')).toBeTruthy();
        expect(ChatClient.prototype.getAChatThread).toHaveBeenCalledWith('8');
    });

    it('reopens the thread that was open last, wherever it was opened', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([thread('7', 'Board triage')]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail(thread('7', 'Board triage'), 'what is stuck?'));
        setActiveThread('7');

        renderHome();

        expect(await screen.findByText('what is stuck?')).toBeTruthy();
    });
});
