import type { Container } from 'injectkit';
import type { AuthenticationSession } from '@maroonedsoftware/authentication';
import { httpError } from '@maroonedsoftware/errors';
import type { Logger } from '@maroonedsoftware/logger';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { Mutex } from '#shared/mutex.js';
import type {
    ChatPendingAction as WirePendingAction,
    ChatThread as WireChatThread,
    ChatThreadDetail,
    ChatTurnResult,
    DecideChatActionRequest,
    RenameChatThreadRequest,
    SendChatMessageRequest,
} from '#src/generated/chat.js';
import { ChatCatalog, explainError } from './chat.catalog.js';
import { publishChat, toStreamEvent } from './chat.feed.js';
import type { ChatEngine } from './chat.engine.js';
import type { ChatEngineChoice } from './chat.engine.setting.js';
import { ChatMessageRepository, type ChatMessage } from './chat.message.repository.js';
import { ChatPendingActionRepository, type PendingAction } from './chat.pending.action.repository.js';
import { chatSystemPrompt } from './chat.prompt.js';
import { ChatThreadRepository, type ChatEngineName, type ChatThread } from './chat.thread.repository.js';
import { chatTools, type ChatTurnContext } from './chat.tools.js';
import { toWireAction, toWireMessage, toWireThread } from './chat.wire.js';

/** A thread's title until its first message names it. */
export const NEW_THREAD_TITLE = 'New chat';

const TITLE_LENGTH = 60;

/** A thread's title, from its first message: the first line, cut to {@link TITLE_LENGTH} characters. */
export const titleFrom = (text: string): string => {
    const line = text.trim().split('\n')[0]!.trim();
    return line.length <= TITLE_LENGTH ? line : `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
};

/** What a follow-up answers when the change it was told about leaves nothing to say or do. */
export const NOTHING_MORE = 'NOTHING_MORE';

/**
 * The note a follow-up turn is given in place of a message from the person: how the change they
 * confirmed went, and what to do about it. Never stored as theirs (`ChatService.followUp`).
 */
export const followUpNote = (action: PendingAction): string =>
    [
        `(A note from Wilson, not from the person.) They confirmed the change you proposed, "${action.summary}" (${action.operation}).`,
        action.status === 'done'
            ? `It was made. The operation answered: ${JSON.stringify(action.result ?? null).slice(0, 2000)}`
            : `It failed: ${action.error ?? 'no reason given'}`,
        'If they asked for more than this one change, propose the next one now. If the outcome needs saying (a failure, or a result that is not what they would expect), say it in a sentence or two.',
        `Otherwise answer exactly ${NOTHING_MORE} and nothing else.`,
    ].join('\n');

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
 * each operation in a fresh scope of it, as each HTTP request gets one (`ChatCatalog.run`). `session`
 * answers with the session of the request in progress, which every operation runs as: read once per
 * message or decision, and carried from there, since a follow-up outlives its request.
 */
export class ChatService {
    private readonly followUps = new Set<Promise<void>>();

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
        private readonly session: () => AuthenticationSession,
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
        const session = this.session();

        return threadLock(id).run(
            `message to chat thread ${id}`,
            message => this.logger.info(message),
            async () => {
                const thread = await this.threadOrThrow(id);
                const history = await this.messages.since(id);
                if (history.length === 0 && thread.title === NEW_THREAD_TITLE) await this.threads.rename(id, titleFrom(said));
                const message = await this.messages.append(id, { role: 'user', content: said });

                const { reply, proposed } = await this.answer(thread, history, said, session, project);
                return { message: toWireMessage(message), reply: toWireMessage(reply!), proposed: proposed.map(toWireAction) };
            },
        );
    }

    async decide(id: string, { decision }: DecideChatActionRequest): Promise<WirePendingAction> {
        const action = await this.actions.get(id);
        if (!action) throw httpError(404).withDetails({ reason: `chat action ${id} not found` });

        const decided = decision === 'decline' ? await this.actions.decline(id) : await this.actions.claim(id);
        if (!decided) throw httpError(409).withDetails({ reason: this.whyUndecidable(action) });
        if (decision === 'decline') return toWireAction(decided);

        const session = this.session();
        let finished: PendingAction | undefined;
        try {
            const result = await this.catalog.run(
                this.container,
                this.logger,
                session,
                action.operation,
                action.arguments as Record<string, unknown>,
                action.project,
            );
            finished = await this.actions.finish(id, { result });
        } catch (err) {
            finished = await this.actions.finish(id, { error: explainError(err) });
        }
        if (finished) this.followUp(finished, session);
        return toWireAction(finished ?? decided);
    }

    /** Resolves once every follow-up this service started has finished: for tests, and an orderly shutdown. */
    async whenIdle(): Promise<void> {
        while (this.followUps.size > 0) await Promise.all(this.followUps);
    }

    /**
     * After a confirmed change, give the chat a turn of its own to carry on: told how the change went
     * ({@link followUpNote}), it proposes the next change the person asked for, says what needs
     * saying, or answers {@link NOTHING_MORE}, in which case nothing is stored. Not awaited by
     * {@link decide}, which answers as soon as the change is made: the follow-up streams to the thread
     * like any turn, and takes the thread's lock, so a message the person sends meanwhile waits for it
     * rather than racing it. A follow-up that fails is logged and published as `failed`, never thrown
     * to anyone.
     */
    private followUp(action: PendingAction, session: AuthenticationSession): void {
        const run = threadLock(action.threadId)
            .run(
                `follow-up to chat action ${action.id}`,
                message => this.logger.info(message),
                async () => {
                    const thread = await this.threads.get(action.threadId);
                    if (!thread) return;
                    const history = await this.messages.since(thread.id);
                    await this.answer(thread, history, followUpNote(action), session, action.project, { followUp: true });
                },
            )
            .catch(err => this.logger.warn(`chat action ${action.id}: the follow-up failed: ${explainError(err)}`))
            .finally(() => this.followUps.delete(run));
        this.followUps.add(run);
    }

    /**
     * Run one turn on the thread's engine and store its answer, publishing its progress to anyone
     * watching the thread (`chatFeed`) as it goes.
     */
    private async answer(
        thread: ChatThread,
        history: ChatMessage[],
        text: string,
        session: AuthenticationSession,
        project?: string,
        { followUp = false }: { followUp?: boolean } = {},
    ): Promise<{ reply?: ChatMessage; proposed: PendingAction[] }> {
        const fail = (reason: string): never => {
            publishChat(thread.id, { event: 'failed', data: { reason } });
            throw httpError(502).withDetails({ reason });
        };

        const engine = this.engines[thread.engine];
        if (!engine) return fail(`the chat could not answer: the '${thread.engine}' engine is not available`);

        const { provider, model } = await this.choose();
        const projects = (await this.projects.list()).map(row => row.name);
        const context: ChatTurnContext = {
            threadId: thread.id,
            container: this.container,
            logger: this.logger,
            session,
            operations: [],
            proposed: [],
            emit: event => publishChat(thread.id, toStreamEvent(event)),
        };

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
                onText: delta => publishChat(thread.id, { event: 'delta', data: delta }),
            });
        } catch (err) {
            this.logger.warn(`chat thread ${thread.id}: the turn failed: ${explainError(err)}`);
            return fail(`the chat could not answer: ${explainError(err)}`);
        }

        if (output.engineSessionId) await this.threads.setEngineSessionId(thread.id, output.engineSessionId);
        if (followUp && output.text.trim() === NOTHING_MORE && context.proposed.length === 0) {
            publishChat(thread.id, { event: 'done', data: { seq: history.at(-1)?.seq ?? 0 } });
            return { proposed: [] };
        }
        const reply = await this.messages.append(thread.id, {
            role: 'assistant',
            content: output.text.trim().replace(NOTHING_MORE, '').trim() || '(no answer)',
            operations: context.operations,
            // A follow-up's note is not stored as a message, so the 'api' engine keeps it at the head
            // of the answer's own record: replayed next turn, the answer still follows what prompted it
            // rather than a second answer in a row.
            engineMessages:
                followUp && Array.isArray(output.engineMessages)
                    ? [{ role: 'user', content: text }, ...output.engineMessages]
                    : output.engineMessages,
        });
        publishChat(thread.id, { event: 'done', data: { seq: reply.seq } });
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
