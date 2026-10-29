// @vitest-environment jsdom
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, HealthClient, ProjectsClient, SdkError } from '@wilson/sdk';
import type { ChatMessage, ChatPendingAction, ChatThread, ChatThreadDetail, ChatTurnResult, Health } from '@wilson/sdk';
import { setActiveThread } from '#src/lib/chat.js';
import { routeTree } from '#src/routeTree.gen.js';

/**
 * The chat panel (`ChatPanel.tsx`), driven through the real app: the header's Chat button on the
 * dashboard, the generated chat client stubbed on its prototype, and the stream through a fake
 * `EventSource`. What these pin is what the person sees: a change only ever runs from a Confirm
 * they clicked, and an answer shows as it streams in.
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

const thread: ChatThread = {
    id: '7',
    title: 'New chat',
    engine: 'cli',
    createdAt: at('2026-10-29T10:00:00Z'),
    updatedAt: at('2026-10-29T10:00:00Z'),
};

const message = (seq: number, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    seq,
    role,
    content,
    operations: [],
    createdAt: at(`2026-10-29T10:00:0${seq}Z`),
    ...extra,
});

const action = (overrides: Partial<ChatPendingAction> = {}): ChatPendingAction => ({
    id: '31',
    threadId: '7',
    project: 'demo',
    operation: 'move_card',
    arguments: { id: '0007', body: { stage: 'implementing' } },
    summary: 'Move 0007 to implementing.',
    status: 'pending',
    expiresAt: DateTime.now().plus({ minutes: 10 }),
    createdAt: at('2026-10-29T10:00:03Z'),
    ...overrides,
});

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readonly url: string;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
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

    close() {}

    emit(type: string, data = '') {
        for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }));
    }
}

const chatStreams = () => FakeEventSource.instances.filter(source => source.url.includes('/api/chat/threads/'));

class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderApp(path = '/') {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
}

const openChat = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Chat' }));
    return screen.findByRole('textbox', { name: 'Message' });
};

const send = (box: HTMLElement, text: string) => {
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};

const detail = (messages: ChatMessage[], actions: ChatPendingAction[] = [], title = 'What is in review?'): ChatThreadDetail => ({
    thread: { ...thread, title },
    messages,
    actions,
});

beforeEach(() => {
    // The open thread is shared app state (`setActiveThread`), so each test starts on a new chat.
    setActiveThread(undefined);
    FakeEventSource.instances = [];
    vi.spyOn(HealthClient.prototype, 'getHealth').mockResolvedValue(baseHealth);
    vi.spyOn(ProjectsClient.prototype, 'listProjects').mockResolvedValue([{ name: 'demo' }]);
    vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([]);
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
    // The composer is an autosizing `Textarea`, which listens for `document.fonts`' `loadingdone` to
    // re-measure itself; jsdom has no `document.fonts`. The same stub `planning-session.test.ts` uses.
    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the chat panel', () => {
    it('reads nothing and opens no stream until it is opened', async () => {
        renderApp();
        await screen.findByRole('button', { name: 'Chat' });

        expect(ChatClient.prototype.listChatThreads).not.toHaveBeenCalled();
        expect(chatStreams()).toEqual([]);

        await openChat();

        await waitFor(() => expect(ChatClient.prototype.listChatThreads).toHaveBeenCalled());
    });

    it('starts a thread, listens to it, then sends the message to it, and shows the stored answer', async () => {
        const start = vi.spyOn(ChatClient.prototype, 'startAChatThread').mockResolvedValue(thread);
        const sendMessage = vi.spyOn(ChatClient.prototype, 'sendAChatMessage').mockImplementation(async () => {
            expect(chatStreams().map(source => source.url)).toEqual([expect.stringContaining('/api/chat/threads/7/stream')]);
            return {
                message: message(1, 'user', 'What is in review?'),
                reply: message(2, 'assistant', 'One card: **0007**.'),
                proposed: [],
            } satisfies ChatTurnResult;
        });
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([
                message(1, 'user', 'What is in review?'),
                message(2, 'assistant', 'One card: **0007**.', { operations: [{ name: 'list_cards', arguments: {}, project: 'demo', ok: true }] }),
            ]),
        );
        renderApp();

        send(await openChat(), 'What is in review?');

        expect(await screen.findByText('0007')).toBeTruthy();
        expect(screen.getByText('list_cards · demo')).toBeTruthy();
        expect(start).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith('7', { text: 'What is in review?' });
    });

    it('shows the answer as it streams in, before the turn is stored', async () => {
        vi.spyOn(ChatClient.prototype, 'startAChatThread').mockResolvedValue(thread);
        let finish!: (turn: ChatTurnResult) => void;
        vi.spyOn(ChatClient.prototype, 'sendAChatMessage').mockReturnValue(new Promise(resolve => (finish = resolve)));
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([]));
        renderApp();

        send(await openChat(), 'What is in review?');
        await waitFor(() => expect(chatStreams()).toHaveLength(1));
        act(() => {
            chatStreams()[0]!.emit('delta', 'Looking at ');
            chatStreams()[0]!.emit('delta', 'the board');
            chatStreams()[0]!.emit('operation', JSON.stringify({ name: 'list_cards', arguments: {}, project: 'demo', ok: true }));
        });

        expect(await screen.findByText('Looking at the board')).toBeTruthy();
        expect(screen.getByText('list_cards · demo')).toBeTruthy();
        act(() => finish({ message: message(1, 'user', 'What is in review?'), reply: message(2, 'assistant', 'done'), proposed: [] }));
    });

    it('runs a proposed change only when the person confirms it', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([{ ...thread, title: 'Move it' }]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([message(1, 'user', 'Move 0007'), message(2, 'assistant', 'Proposed.')], [action()], 'Move it'),
        );
        const decide = vi.spyOn(ChatClient.prototype, 'decideAChatAction').mockResolvedValue(action({ status: 'done' }));
        renderApp();
        await openChat();

        fireEvent.click(await screen.findByRole('combobox', { name: 'Thread' }));
        fireEvent.click(await screen.findByRole('option', { name: 'Move it', hidden: true }));

        expect(await screen.findByText('Move 0007 to implementing.')).toBeTruthy();
        expect(decide).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(decide).toHaveBeenCalledWith('31', { decision: 'confirm' }));
    });

    it('shows the follow-up to a confirmed change as it streams in', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([{ ...thread, title: 'Move it' }]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([message(1, 'user', 'Move 0007, then release it')], [action()], 'Move it'),
        );
        vi.spyOn(ChatClient.prototype, 'decideAChatAction').mockResolvedValue(action({ status: 'done' }));
        renderApp();
        await openChat();
        fireEvent.click(await screen.findByRole('combobox', { name: 'Thread' }));
        fireEvent.click(await screen.findByRole('option', { name: 'Move it', hidden: true }));
        fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(chatStreams().length).toBeGreaterThan(0));
        act(() => chatStreams().at(-1)!.emit('delta', 'Moved. Next, the release.'));

        expect(await screen.findByText('Moved. Next, the release.')).toBeTruthy();
    });

    it('declines a proposed change', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([{ ...thread, title: 'Move it' }]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([message(1, 'user', 'Move 0007')], [action()], 'Move it'));
        const decide = vi.spyOn(ChatClient.prototype, 'decideAChatAction').mockResolvedValue(action({ status: 'declined' }));
        renderApp();
        await openChat();
        fireEvent.click(await screen.findByRole('combobox', { name: 'Thread' }));
        fireEvent.click(await screen.findByRole('option', { name: 'Move it', hidden: true }));

        fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));

        await waitFor(() => expect(decide).toHaveBeenCalledWith('31', { decision: 'decline' }));
    });

    it('offers no Confirm for a proposal that has expired, and shows how a failed one went', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([{ ...thread, title: 'Old' }]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail(
                [message(1, 'user', 'Move things')],
                [
                    action({ id: '1', summary: 'Move 0007.', expiresAt: DateTime.now().minus({ minutes: 1 }) }),
                    action({ id: '2', summary: 'Release 0008.', status: 'failed', error: 'card 0008 holds no lease' }),
                ],
                'Old',
            ),
        );
        renderApp();
        await openChat();
        fireEvent.click(await screen.findByRole('combobox', { name: 'Thread' }));
        fireEvent.click(await screen.findByRole('option', { name: 'Old', hidden: true }));

        expect(await screen.findByText('expired')).toBeTruthy();
        expect(screen.getByText('card 0008 holds no lease')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    });

    it("shows the server's reason when the chat cannot answer, and keeps what was typed", async () => {
        vi.spyOn(ChatClient.prototype, 'startAChatThread').mockResolvedValue(thread);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([message(1, 'user', 'hello?')]));
        vi.spyOn(ChatClient.prototype, 'sendAChatMessage').mockRejectedValue(
            new SdkError(502, 'Bad Gateway', {
                message: 'Bad Gateway',
                details: { reason: 'the chat could not answer: ANTHROPIC_API_KEY is not set' },
            }),
        );
        renderApp();

        const box = await openChat();
        send(box, 'hello?');

        expect(await screen.findByText('the chat could not answer: ANTHROPIC_API_KEY is not set')).toBeTruthy();
        expect((box as HTMLTextAreaElement).value).toBe('hello?');
    });
});
