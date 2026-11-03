// @vitest-environment jsdom
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, HealthClient, ProjectsClient, SdkError } from '@wilson/sdk';
import type { ChatMessage, ChatPendingAction, ChatPendingQuestion, ChatQuestion, ChatThread, ChatThreadDetail, Health } from '@wilson/sdk';
import { setActiveThread } from '#src/lib/chat.js';
import { setChatDockOpen, setChatDockPosition } from '#src/lib/chat.dock.js';
import { routeTree } from '#src/routeTree.gen.js';

/**
 * `ChatQuestionCard` (`ChatView.tsx`), driven through the real app the same way `chat-dock.test.ts`
 * drives `ChatActionCard`. What these pin: a question only ever gets answered by a Submit the person
 * clicked, by index into its own options, once, whatever else is on the thread; and the card never
 * offers a control the server would refuse — past its expiry, once dismissed, or once answered.
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
    title: 'Questions',
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

const SINGLE_QUESTION: ChatQuestion = {
    header: 'Repo',
    text: 'Which repository did you mean?',
    options: [
        { label: 'wilson', description: 'The board app itself.' },
        { label: 'ats', description: 'The other repo.' },
    ],
    multiSelect: false,
};

const MULTI_QUESTION: ChatQuestion = {
    header: 'Checks',
    text: 'Which checks should run?',
    options: [
        { label: 'lint', description: 'Static checks.' },
        { label: 'test', description: 'The test suite.' },
        { label: 'build', description: 'The production build.' },
    ],
    multiSelect: true,
};

const question = (overrides: Partial<ChatPendingQuestion> = {}): ChatPendingQuestion => ({
    id: '50',
    threadId: '7',
    questions: [SINGLE_QUESTION, MULTI_QUESTION],
    status: 'pending',
    expiresAt: DateTime.now().plus({ minutes: 10 }),
    createdAt: at('2026-10-29T10:00:05Z'),
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

const detail = (
    messages: ChatMessage[] = [],
    actions: ChatPendingAction[] = [],
    questions: ChatPendingQuestion[] = [],
    title = 'Questions',
): ChatThreadDetail => ({
    thread: { ...thread, title },
    messages,
    actions,
    questions,
});

beforeEach(() => {
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

describe('a question the chat asked', () => {
    it('renders among the messages by its createdAt, with every header, option and an Other box', async () => {
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([message(1, 'user', 'Before the question'), message(9, 'assistant', 'After the question')], [], [question()]),
        );
        setActiveThread('7');
        renderApp();
        await openChat();

        const before = await screen.findByText('Before the question');
        const card = screen.getByRole('group', { name: 'Question' });
        const after = screen.getByText('After the question');
        expect(before.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(card.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        expect(within(card).getByText('Repo')).toBeTruthy();
        expect(within(card).getByText('Checks')).toBeTruthy();
        expect(within(card).getByText('wilson')).toBeTruthy();
        expect(within(card).getByText('ats')).toBeTruthy();
        expect(within(card).getByText('lint')).toBeTruthy();
        expect(within(card).getByText('test')).toBeTruthy();
        expect(within(card).getByText('build')).toBeTruthy();
        expect(within(card).getAllByRole('textbox', { name: 'Other' })).toHaveLength(2);
    });

    it('disables Submit until every question has an answer', async () => {
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([], [], [question()]));
        setActiveThread('7');
        renderApp();
        await openChat();

        const submit = (await screen.findByRole('button', { name: 'Submit' })) as HTMLButtonElement;
        expect(submit.disabled).toBe(true);

        fireEvent.click(screen.getByRole('radio', { name: 'wilson' }));
        expect(submit.disabled).toBe(true);

        fireEvent.click(screen.getByRole('checkbox', { name: 'lint' }));
        expect(submit.disabled).toBe(false);
    });

    it('is satisfied by Other text alone, with no option selected', async () => {
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([], [], [question({ questions: [SINGLE_QUESTION] })]));
        setActiveThread('7');
        renderApp();
        await openChat();

        const submit = (await screen.findByRole('button', { name: 'Submit' })) as HTMLButtonElement;
        expect(submit.disabled).toBe(true);

        fireEvent.change(screen.getByRole('textbox', { name: 'Other' }), { target: { value: 'Neither of those' } });

        expect(submit.disabled).toBe(false);
        expect(screen.queryByRole('radio', { checked: true })).toBeNull();
    });

    it('submits chosen options by 0-based index, ascending for a multi-select, with no "other" key when the box was left blank', async () => {
        const answerChatQuestions = vi.spyOn(ChatClient.prototype, 'answerChatQuestions').mockResolvedValue(question({ status: 'answered' }));
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([], [], [question({ id: '50' })]));
        setActiveThread('7');
        renderApp();
        await openChat();

        fireEvent.click(await screen.findByRole('radio', { name: 'ats' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'build' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'lint' }));
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

        await waitFor(() =>
            expect(answerChatQuestions).toHaveBeenCalledWith('7', '50', { answers: [{ chosen: [1] }, { chosen: [0, 2] }] }),
        );
        expect(answerChatQuestions).toHaveBeenCalledTimes(1);
    });

    it('sends Other text trimmed, under "other", with chosen: [] where nothing was picked', async () => {
        const answerChatQuestions = vi.spyOn(ChatClient.prototype, 'answerChatQuestions').mockResolvedValue(question({ status: 'answered' }));
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([], [], [question({ id: '51', questions: [SINGLE_QUESTION] })]),
        );
        setActiveThread('7');
        renderApp();
        await openChat();

        fireEvent.change(await screen.findByRole('textbox', { name: 'Other' }), { target: { value: '  Neither of those  ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

        await waitFor(() =>
            expect(answerChatQuestions).toHaveBeenCalledWith('7', '51', { answers: [{ chosen: [], other: 'Neither of those' }] }),
        );
    });

    it('treats a single-select option and its Other text as one answer: whichever came last replaces the other', async () => {
        const answerChatQuestions = vi.spyOn(ChatClient.prototype, 'answerChatQuestions').mockResolvedValue(question({ status: 'answered' }));
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([], [], [question({ id: '52', questions: [SINGLE_QUESTION] })]),
        );
        setActiveThread('7');
        renderApp();
        await openChat();

        const radio = (await screen.findByRole('radio', { name: 'wilson' })) as HTMLInputElement;
        const box = screen.getByRole('textbox', { name: 'Other' }) as HTMLInputElement;

        fireEvent.click(radio);
        fireEvent.change(box, { target: { value: 'Neither of those' } });
        expect(radio.checked).toBe(false);

        fireEvent.click(radio);
        expect(radio.checked).toBe(true);
        expect(box.value).toBe('');

        fireEvent.change(box, { target: { value: 'Neither of those' } });
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

        await waitFor(() =>
            expect(answerChatQuestions).toHaveBeenCalledWith('7', '52', { answers: [{ chosen: [], other: 'Neither of those' }] }),
        );
    });

    it('keeps a multi-select option alongside Other text', async () => {
        const answerChatQuestions = vi.spyOn(ChatClient.prototype, 'answerChatQuestions').mockResolvedValue(question({ status: 'answered' }));
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([], [], [question({ id: '53', questions: [MULTI_QUESTION] })]),
        );
        setActiveThread('7');
        renderApp();
        await openChat();

        fireEvent.click(await screen.findByRole('checkbox', { name: 'lint' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Other' }), { target: { value: 'and typecheck' } });
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

        await waitFor(() =>
            expect(answerChatQuestions).toHaveBeenCalledWith('7', '53', { answers: [{ chosen: [0], other: 'and typecheck' }] }),
        );
    });

    it('shows the chosen option labels and Other text once answered, and offers no controls', async () => {
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail(
                [],
                [],
                [
                    question({
                        status: 'answered',
                        answers: [{ chosen: [1] }, { chosen: [0, 2], other: 'extra note' }],
                    }),
                ],
            ),
        );
        setActiveThread('7');
        renderApp();
        await openChat();

        expect(await screen.findByText('answered')).toBeTruthy();
        expect(screen.getByText('ats')).toBeTruthy();
        expect(screen.getByText('lint, build, extra note')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
        expect(screen.queryAllByRole('radio')).toHaveLength(0);
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });

    it('shows "expired" for a pending question past its expiry, and "dismissed" for a dismissed one, neither with controls', async () => {
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail(
                [],
                [],
                [
                    question({ id: '60', expiresAt: DateTime.now().minus({ minutes: 1 }) }),
                    question({ id: '61', status: 'dismissed' }),
                ],
            ),
        );
        setActiveThread('7');
        renderApp();
        await openChat();

        expect(await screen.findByText('expired')).toBeTruthy();
        expect(screen.getByText('dismissed')).toBeTruthy();
        expect(screen.queryAllByRole('button', { name: 'Submit' })).toHaveLength(0);
        expect(screen.queryAllByRole('radio')).toHaveLength(0);
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });

    it('is still answerable after the dock closes and the home page opens on the same thread', async () => {
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([{ ...thread, title: 'Questions' }]);
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([], [], [question({ id: '70' })]));
        const answerChatQuestions = vi.spyOn(ChatClient.prototype, 'answerChatQuestions').mockResolvedValue(question({ id: '70', status: 'answered' }));
        setActiveThread('7');
        renderApp();
        await openChat();
        await screen.findByRole('group', { name: 'Question' });

        fireEvent.click(screen.getByRole('button', { name: 'Open as the home page' }));

        const card = await screen.findByRole('group', { name: 'Question' });
        fireEvent.click(within(card).getByRole('radio', { name: 'wilson' }));
        fireEvent.click(within(card).getByRole('checkbox', { name: 'lint' }));
        fireEvent.click(within(card).getByRole('button', { name: 'Submit' }));

        await waitFor(() =>
            expect(answerChatQuestions).toHaveBeenCalledWith('7', '70', { answers: [{ chosen: [0] }, { chosen: [0] }] }),
        );
    });

    it('leaves the composer enabled with its own placeholder while pending, and still sends a message typed past it', async () => {
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([message(1, 'user', 'hi')], [], [question()]));
        const sendMessage = vi.spyOn(ChatClient.prototype, 'sendAChatMessage').mockReturnValue(new Promise(() => {}));
        setActiveThread('7');
        renderApp();
        const box = (await openChat()) as HTMLTextAreaElement;
        await screen.findByRole('group', { name: 'Question' });

        expect(box.getAttribute('placeholder')).toBe('Answer above, or ask for something else…');
        expect(box.disabled).toBe(false);

        fireEvent.change(box, { target: { value: 'something else' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('7', { text: 'something else' }));
    });

    it('offers no follow-up chips while pending, even when the latest answer carries suggestions', async () => {
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(
            detail([message(1, 'user', 'hi'), message(2, 'assistant', 'Answer.', { suggestions: ['Try this?'] })], [], [question()]),
        );
        setActiveThread('7');
        renderApp();
        await openChat();

        await screen.findByRole('group', { name: 'Question' });
        expect(screen.queryByText('Try this?')).toBeNull();
    });

    it("shows the endpoint's own refusal sentence on the card", async () => {
        vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail([], [], [question({ questions: [SINGLE_QUESTION] })]));
        vi.spyOn(ChatClient.prototype, 'answerChatQuestions').mockRejectedValue(
            new SdkError(409, 'Conflict', { message: 'Conflict', details: { reason: 'that question was already answered' } }, new Headers()),
        );
        setActiveThread('7');
        renderApp();
        await openChat();

        fireEvent.click(await screen.findByRole('radio', { name: 'wilson' }));
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

        expect(await screen.findByText('that question was already answered')).toBeTruthy();
    });

    it('refetches the thread on an "asked" stream event, the same way a "proposed" one does', async () => {
        const getAChatThread = vi.spyOn(ChatClient.prototype, 'getAChatThread').mockResolvedValue(detail());
        setActiveThread('7');
        renderApp();
        await openChat();
        await waitFor(() => expect(chatStreams()).toHaveLength(1));
        getAChatThread.mockClear();

        act(() => chatStreams()[0]!.emit('asked'));

        await waitFor(() => expect(getAChatThread).toHaveBeenCalled());
    });
});
