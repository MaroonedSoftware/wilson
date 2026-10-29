import type { Container } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import type { Logger } from '@maroonedsoftware/logger';
import type { Provider } from '#modules/agent/model.registry.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { Mutex } from '#shared/mutex.js';
import type {
    ChatMessage as WireChatMessage,
    ChatPendingAction as WirePendingAction,
    ChatThread as WireChatThread,
    ChatThreadDetail,
    ChatTurnResult,
    DecideChatActionRequest,
    RenameChatThreadRequest,
    SendChatMessageRequest,
} from '#src/generated/chat.js';
import { ChatCatalog, explainError } from './chat.catalog.js';
import type { ChatEngine } from './chat.engine.js';
import { ChatMessageRepository, type ChatMessage } from './chat.message.repository.js';
import { ChatPendingActionRepository, type PendingAction } from './chat.pending.action.repository.js';
import { chatSystemPrompt } from './chat.prompt.js';
import { ChatThreadRepository, type ChatEngineName, type ChatThread } from './chat.thread.repository.js';
import { chatTools, type ChatTurnContext } from './chat.tools.js';

/** Which engine a new thread runs on, and the model every turn uses. */
export interface ChatEngineChoice {
    engine: ChatEngineName;
    provider: Provider;
    model: string;
}

/** A thread's title until its first message names it. */
export const NEW_THREAD_TITLE = 'New chat';

const TITLE_LENGTH = 60;

/** A thread's title, from its first message: the first line, cut to {@link TITLE_LENGTH} characters. */
export const titleFrom = (text: string): string => {
    const line = text.trim().split('\n')[0]!.trim();
    return line.length <= TITLE_LENGTH ? line : `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
};

const toWireThread = (thread: ChatThread): WireChatThread => ({
    id: thread.id,
    title: thread.title,
    engine: thread.engine,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.archivedAt ? { archivedAt: thread.archivedAt } : {}),
});

const toWireMessage = (message: ChatMessage): WireChatMessage => ({
    seq: message.seq,
    role: message.role,
    content: message.content,
    operations: message.operations.map(operation => ({
        ...operation,
        arguments: operation.arguments as WireChatMessage['operations'][number]['arguments'],
    })),
    createdAt: message.createdAt,
});

export const toWireAction = (action: PendingAction): WirePendingAction => ({
    id: action.id,
    threadId: action.threadId,
    operation: action.operation,
    arguments: action.arguments as WirePendingAction['arguments'],
    summary: action.summary,
    status: action.status,
    expiresAt: action.expiresAt,
    createdAt: action.createdAt,
    ...(action.project ? { project: action.project } : {}),
    ...(action.result !== undefined ? { result: action.result as WirePendingAction['result'] } : {}),
    ...(action.error ? { error: action.error } : {}),
    ...(action.decidedAt ? { decidedAt: action.decidedAt } : {}),
});

/**
 * One lock per thread, so a second message sent while the first is still being answered waits for
 * it rather than racing it: each turn reads the thread's history, and two at once would each answer
 * without the other.
 */
const threadLocks = new Map<string, Mutex>();
const threadLock = (threadId: string): Mutex => {
    let lock = threadLocks.get(threadId);
    if (!lock) threadLocks.set(threadId, (lock = new Mutex(`chat thread ${threadId}`)));
    return lock;
};

/**
 * The chat (`chat.ck`). A turn stores the person's message, runs the thread's engine with the four
 * chat tools (`chatTools`), and stores its answer with the operations it ran. A change the answer
 * proposed runs only through {@link decide}, as the person's own act.
 *
 * Takes the container itself, registered through a factory (`ChatModule`), because the catalog runs
 * each operation in a fresh scope of it, as each HTTP request gets one (`ChatCatalog.run`).
 */
export class ChatService {
    constructor(
        private readonly container: Container,
        private readonly logger: Logger,
        private readonly threads: ChatThreadRepository,
        private readonly messages: ChatMessageRepository,
        private readonly actions: ChatPendingActionRepository,
        private readonly catalog: ChatCatalog,
        private readonly projects: ProjectRepository,
        private readonly engines: Record<ChatEngineName, ChatEngine | undefined>,
        private readonly choose: () => Promise<ChatEngineChoice>,
    ) {}

    async listThreads(): Promise<WireChatThread[]> {
        return (await this.threads.list()).map(toWireThread);
    }

    async startThread(): Promise<WireChatThread> {
        const { engine } = await this.choose();
        return toWireThread(await this.threads.create(NEW_THREAD_TITLE, engine));
    }

    async getThread(id: string): Promise<ChatThreadDetail> {
        const thread = await this.threadOrThrow(id);
        const [messages, actions] = await Promise.all([this.messages.since(id), this.actions.forThread(id)]);
        return { thread: toWireThread(thread), messages: messages.map(toWireMessage), actions: actions.map(toWireAction) };
    }

    async renameThread(id: string, { title }: RenameChatThreadRequest): Promise<WireChatThread> {
        const trimmed = title.trim();
        if (!trimmed) throw httpError(400).withDetails({ reason: 'a thread needs a title' });
        const thread = await this.threads.rename(id, trimmed);
        if (!thread) throw httpError(404).withDetails({ reason: `chat thread ${id} not found` });
        return toWireThread(thread);
    }

    async archiveThread(id: string): Promise<WireChatThread> {
        const thread = await this.threads.archive(id);
        if (!thread) throw httpError(404).withDetails({ reason: `chat thread ${id} not found` });
        return toWireThread(thread);
    }

    async sendMessage(id: string, { text, project }: SendChatMessageRequest): Promise<ChatTurnResult> {
        const said = text.trim();
        if (!said) throw httpError(400).withDetails({ reason: 'a message needs some text' });
        await this.threadOrThrow(id);

        return threadLock(id).run(
            `message to chat thread ${id}`,
            message => this.logger.info(message),
            async () => {
                const thread = await this.threadOrThrow(id);
                const history = await this.messages.since(id);
                if (history.length === 0 && thread.title === NEW_THREAD_TITLE) await this.threads.rename(id, titleFrom(said));
                const message = await this.messages.append(id, { role: 'user', content: said });

                const { reply, proposed } = await this.answer(thread, history, said, project);
                return { message: toWireMessage(message), reply: toWireMessage(reply), proposed: proposed.map(toWireAction) };
            },
        );
    }

    async decide(id: string, { decision }: DecideChatActionRequest): Promise<WirePendingAction> {
        const action = await this.actions.get(id);
        if (!action) throw httpError(404).withDetails({ reason: `chat action ${id} not found` });

        const decided = decision === 'decline' ? await this.actions.decline(id) : await this.actions.claim(id);
        if (!decided) throw httpError(409).withDetails({ reason: this.whyUndecidable(action) });
        if (decision === 'decline') return toWireAction(decided);

        let finished: PendingAction | undefined;
        try {
            const result = await this.catalog.run(
                this.container,
                this.logger,
                action.operation,
                action.arguments as Record<string, unknown>,
                action.project,
            );
            finished = await this.actions.finish(id, { result });
        } catch (err) {
            finished = await this.actions.finish(id, { error: explainError(err) });
        }
        return toWireAction(finished ?? decided);
    }

    /** Run one turn on the thread's engine and store its answer. */
    private async answer(
        thread: ChatThread,
        history: ChatMessage[],
        text: string,
        project?: string,
    ): Promise<{ reply: ChatMessage; proposed: PendingAction[] }> {
        const engine = this.engines[thread.engine];
        if (!engine) throw httpError(502).withDetails({ reason: `the chat could not answer: the '${thread.engine}' engine is not available` });

        const { provider, model } = await this.choose();
        const projects = (await this.projects.list()).map(row => row.name);
        const context: ChatTurnContext = { threadId: thread.id, container: this.container, logger: this.logger, operations: [], proposed: [] };

        let output;
        try {
            output = await engine.turn({
                thread,
                history,
                text,
                system: chatSystemPrompt({ projects, currentProject: project }),
                tools: chatTools(this.catalog, context),
                provider,
                model,
            });
        } catch (err) {
            this.logger.warn(`chat thread ${thread.id}: the turn failed: ${explainError(err)}`);
            throw httpError(502).withDetails({ reason: `the chat could not answer: ${explainError(err)}` });
        }

        if (output.engineSessionId) await this.threads.setEngineSessionId(thread.id, output.engineSessionId);
        const reply = await this.messages.append(thread.id, {
            role: 'assistant',
            content: output.text.trim() || '(no answer)',
            operations: context.operations,
            engineMessages: output.engineMessages,
        });
        return { reply, proposed: context.proposed };
    }

    private whyUndecidable(action: PendingAction): string {
        if (action.status !== 'pending') return `chat action ${action.id} was already decided (${action.status})`;
        return `chat action ${action.id} expired before it was decided; ask for it again`;
    }

    private async threadOrThrow(id: string): Promise<ChatThread> {
        const thread = await this.threads.get(id);
        if (!thread) throw httpError(404).withDetails({ reason: `chat thread ${id} not found` });
        return thread;
    }
}
