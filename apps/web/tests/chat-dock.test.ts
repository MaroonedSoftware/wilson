// @vitest-environment jsdom
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, HealthClient, ProjectsClient, SdkError } from '@wilson/sdk';
import type { ChatMessage, ChatPendingAction, ChatThread, ChatThreadDetail, ChatTurnResult, Health } from '@wilson/sdk';
import { setActiveThread } from '#src/lib/chat.js';
import { setChatDockOpen, setChatDockPosition } from '#src/lib/chat.dock.js';
import { routeTree } from '#src/routeTree.gen.js';

/**
 * The chat dock (`ChatDock.tsx`), driven through the real app: the header's toggle on the dashboard
 * (`/projects`; the home page is the chat itself), the generated chat client stubbed on its
 * prototype, and the stream through a fake `EventSource`. What these pin is what the person sees: a
 * change only ever runs from a Confirm they clicked, an answer shows as it streams in, and the dock
 * keeps the conversation the home page has open.
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

function renderApp(path = '/projects') {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
}

const openChat = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Show the chat' }));
    return screen.findByRole('textbox', { name: 'Message' });
};

const openThread = async (title: string) => {
    fireEvent.click(await screen.findByRole('button', { name: /^Chats: / }));
    fireEvent.click(await screen.findByRole('menuitem', { name: title, hidden: true }));
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
    // The open thread and the dock are shared app state, so each test starts on a new chat with the
    // dock closed on the right.
    setActiveThread(undefined);
    setChatDockOpen(false);
    setChatDockPosition('right');
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

describe('the chat dock', () => {
    it('reads nothing and opens no stream until it is opened', async () => {
        renderApp();
        await screen.findByRole('button', { name: 'Show the chat' });

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
        expect(screen.getByText('list cards in demo')).toBeTruthy();
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
        expect(screen.getByText('list cards in demo')).toBeTruthy();
        act(() => finish({ message: message(1, 'user', 'What is in review?'), reply: message(2, 'assistant', 'done'), proposed: [] }));
    });

    it('clears the box as soon as a message goes', async () => {
        vi.spyOn(ChatClient.prototype, 'startAChatThread').mockResolvedValue(thread);
        vi.spyOn(ChatClient.prototype, 'sendAChatMessage').mockReturnValue(new Promise(() => {}));
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([]));
        renderApp();

        send(await openChat(), 'What is in review?');

        await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(''));
        expect(await screen.findByText('Working on it…')).toBeTruthy();
    });

    it('fills the box with the first suggestion on Tab, only while it is empty', async () => {
        renderApp();
        const box = (await openChat()) as HTMLTextAreaElement;

        fireEvent.keyDown(box, { key: 'Tab' });
        expect(box.value).toBe('What is waiting on me?');

        fireEvent.change(box, { target: { value: 'my own words' } });
        fireEvent.keyDown(box, { key: 'Tab' });
        expect(box.value).toBe('my own words');
    });

    it('offers the follow-ups of the latest answer, sends one on click, and fills the box on Tab', async () => {
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([
                message(1, 'user', 'What is in review?'),
                message(2, 'assistant', 'One card.', { suggestions: ['Why is 0007 stuck?', 'Move 0007 back'] }),
            ]),
        );
        const sendMessage = vi.spyOn(ChatClient.prototype, 'sendAChatMessage').mockReturnValue(new Promise(() => {}));
        setActiveThread('7');
        renderApp();
        const box = (await openChat()) as HTMLTextAreaElement;

        const chip = await screen.findByText('Move 0007 back');
        fireEvent.keyDown(box, { key: 'Tab' });
        expect(box.value).toBe('Why is 0007 stuck?');
        fireEvent.change(box, { target: { value: '' } });

        fireEvent.click(chip);

        await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('7', { text: 'Move 0007 back' }));
    });

    it('offers no follow-ups while a change waits on the person', async () => {
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([message(1, 'user', 'Move 0007'), message(2, 'assistant', 'Proposed.', { suggestions: ['Then what?'] })], [action()]),
        );
        setActiveThread('7');
        renderApp();
        await openChat();

        expect(await screen.findByText('Move 0007 to implementing.')).toBeTruthy();
        expect(screen.queryByText('Then what?')).toBeNull();
    });

    it('keeps the follow-ups block out of an answer as it streams', async () => {
        vi.spyOn(ChatClient.prototype, 'startAChatThread').mockResolvedValue(thread);
        vi.spyOn(ChatClient.prototype, 'sendAChatMessage').mockReturnValue(new Promise(() => {}));
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([]));
        renderApp();

        send(await openChat(), 'What is in review?');
        await waitFor(() => expect(chatStreams()).toHaveLength(1));
        act(() => chatStreams()[0]!.emit('delta', 'One card.\n\n<sugg'));
        expect(await screen.findByText('One card.')).toBeTruthy();

        act(() => chatStreams()[0]!.emit('delta', 'estions>\n- Why?'));
        expect(screen.getByText('One card.')).toBeTruthy();
        expect(screen.queryByText(/Why\?/)).toBeNull();
    });

    it('runs a proposed change only when the person confirms it', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([{ ...thread, title: 'Move it' }]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([message(1, 'user', 'Move 0007'), message(2, 'assistant', 'Proposed.')], [action()], 'Move it'),
        );
        const decide = vi.spyOn(ChatClient.prototype, 'decideAChatAction').mockResolvedValue(action({ status: 'done' }));
        renderApp();
        await openChat();

        await openThread('Move it');

        expect(await screen.findByText('Move 0007 to implementing.')).toBeTruthy();
        expect(screen.getByText('move_card')).toBeTruthy();
        expect(screen.getByText(/"stage":"implementing"/)).toBeTruthy();
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
        await openThread('Move it');
        fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

        await waitFor(() => expect(chatStreams().length).toBeGreaterThan(0));
        act(() => chatStreams().at(-1)!.emit('delta', 'Moved. Next, the release.'));

        expect(await screen.findByText('Moved. Next, the release.')).toBeTruthy();
    });

    it('archives the open chat from the thread menu, and goes back to a new chat', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([{ ...thread, title: 'Move it' }]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([message(1, 'user', 'Move 0007')], [], 'Move it'));
        const archive = vi.spyOn(ChatClient.prototype, 'archiveAChatThread').mockResolvedValue(thread);
        setActiveThread('7');
        renderApp();
        await openChat();

        await screen.findByRole('button', { name: 'Chats: Move it' });
        await openThread('Archive this chat');

        await waitFor(() => expect(archive).toHaveBeenCalledWith('7'));
        expect(await screen.findByText('What should we do?')).toBeTruthy();
    });

    it('declines a proposed change', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([{ ...thread, title: 'Move it' }]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([message(1, 'user', 'Move 0007')], [action()], 'Move it'));
        const decide = vi.spyOn(ChatClient.prototype, 'decideAChatAction').mockResolvedValue(action({ status: 'declined' }));
        renderApp();
        await openChat();
        await openThread('Move it');

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
        await openThread('Old');

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
        await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('hello?'));
    });
});

describe('the dock itself', () => {
    it('opens beside the page, and closes from its own control or the header toggle', async () => {
        renderApp();
        await openChat();

        expect(screen.getByRole('region', { name: 'Chat' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Hide the chat' }).getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(screen.getByRole('button', { name: 'Close the chat' }));
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Chat' })).toBeNull());

        fireEvent.click(screen.getByRole('button', { name: 'Show the chat' }));
        expect(await screen.findByRole('region', { name: 'Chat' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Hide the chat' }));
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Chat' })).toBeNull());
    });

    it('toggles with Ctrl+J', async () => {
        renderApp();
        await screen.findByRole('button', { name: 'Show the chat' });

        fireEvent.keyDown(document.documentElement, { key: 'j', code: 'KeyJ', ctrlKey: true });

        expect(await screen.findByRole('region', { name: 'Chat' })).toBeTruthy();
    });

    it('moves between the right and the bottom', async () => {
        renderApp();
        await openChat();

        fireEvent.click(screen.getByRole('button', { name: 'Dock at the bottom' }));
        expect(await screen.findByRole('button', { name: 'Dock on the right' })).toBeTruthy();
        expect(screen.getByRole('separator', { name: 'Resize the chat' }).getAttribute('aria-orientation')).toBe('horizontal');

        fireEvent.click(screen.getByRole('button', { name: 'Dock on the right' }));
        expect(await screen.findByRole('button', { name: 'Dock at the bottom' })).toBeTruthy();
    });

    it('resizes from the keyboard, within its limits', async () => {
        renderApp();
        await openChat();
        const handle = screen.getByRole('separator', { name: 'Resize the chat' });
        const width = Number(handle.getAttribute('aria-valuenow'));

        fireEvent.keyDown(handle, { key: 'ArrowLeft' });
        await waitFor(() => expect(Number(handle.getAttribute('aria-valuenow'))).toBe(width + 24));

        for (let i = 0; i < 40; i++) fireEvent.keyDown(handle, { key: 'ArrowLeft' });
        await waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe(handle.getAttribute('aria-valuemax')));
    });

    it('opens as the home page, which keeps the same conversation', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([{ ...thread, title: 'Move it' }]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([message(1, 'user', 'Move 0007')], [], 'Move it'));
        setActiveThread('7');
        renderApp();
        await openChat();
        expect(await screen.findByText('Move 0007')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Open as the home page' }));

        expect(within(await screen.findByRole('navigation', { name: 'Chats' })).getByText('Move it')).toBeTruthy();
        expect(screen.getByText('Move 0007')).toBeTruthy();
        expect(screen.queryByText('What should we do?')).toBeNull();
        expect(screen.queryByRole('region', { name: 'Chat' })).toBeNull();
    });
});
