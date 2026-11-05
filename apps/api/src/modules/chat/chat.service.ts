import type { Container } from 'injectkit';
import type { AuthenticationSession } from '@maroonedsoftware/authentication';
import { httpError } from '@maroonedsoftware/errors';
import type { Logger } from '@maroonedsoftware/logger';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { GoalRepository } from '#modules/goal/goal.repository.js';
import { parseAttachmentId, type AttachmentImageType } from '#modules/context/attachment.bytes.js';
import { Mutex } from '#shared/mutex.js';
import type {
    AnswerChatQuestionsRequest,
    ChatPendingAction as WirePendingAction,
    ChatPendingQuestion as WirePendingQuestion,
    ChatThread as WireChatThread,
    ChatThreadDetail,
    ChatTurnResult,
    DecideChatActionRequest,
    RenameChatThreadRequest,
    SendChatMessageRequest,
} from '#src/generated/chat.js';
import { ChatAttachmentRepository, type StoredChatAttachment, type StoredChatAttachmentWithBytes } from './chat.attachment.repository.js';
import { ChatCatalog, explainError } from './chat.catalog.js';
import { publishChat, toStreamEvent } from './chat.feed.js';
import { ChatQuestionRepository, type PendingQuestion } from './chat.question.repository.js';
import { describeAnswers, validateAnswers, type QuestionAnswer } from './chat.questions.js';
import { splitSuggestions } from './chat.suggestions.js';
import type { ChatEngine, ChatImage, ChatTurnHistory } from './chat.engine.js';
import type { ChatEngineChoice } from './chat.engine.setting.js';
import { ChatMessageRepository, type ChatMessage } from './chat.message.repository.js';
import { ChatPendingActionRepository, type PendingAction } from './chat.pending.action.repository.js';
import { chatSystemPrompt } from './chat.prompt.js';
import { ChatThreadRepository, type ChatEngineName, type ChatThread } from './chat.thread.repository.js';
import { chatTools, type ChatTurnContext } from './chat.tools.js';
import { ChatUsageRepository } from './chat.usage.repository.js';
import { toWireAction, toWireMessage, toWireQuestion, toWireThread } from './chat.wire.js';

/** A thread's title until its first message names it. */
export const NEW_THREAD_TITLE = 'New chat';

/** A thread's title when its first message is only images. */
export const IMAGE_THREAD_TITLE = 'Image';

/** The most images one message can carry. */
export const MAX_IMAGES_PER_MESSAGE = 5;

/**
 * How many image-bearing messages the 'api' engine resends the images of, newest first. It replays
 * the thread every turn, so without a limit a long thread's every message would cost all of them.
 */
export const REPLAYED_IMAGE_MESSAGES = 3;

const toImage = (attachment: StoredChatAttachmentWithBytes): ChatImage => ({
    // `ChatAttachmentService.upload` only ever stores what `sniffImageType` returned.
    contentType: attachment.contentType as AttachmentImageType,
    bytes: attachment.bytes,
});

const groupByMessage = <T extends StoredChatAttachment>(attachments: T[]): Map<number, T[]> => {
    const grouped = new Map<number, T[]>();
    for (const attachment of attachments) {
        const seq = attachment.messageSeq!;
        grouped.set(seq, [...(grouped.get(seq) ?? []), attachment]);
    }
    return grouped;
};

const TITLE_LENGTH = 60;

/** A thread's title, from its first message: the first line, cut to {@link TITLE_LENGTH} characters. */
export const titleFrom = (text: string): string => {
    const line = text.trim().split('\n')[0]!.trim();
    return line.length <= TITLE_LENGTH ? line : `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
};

/** What a turn left behind: its answer, unless it had nothing to say, and what it proposed and asked. */
export interface NoteOutcome {
    reply?: ChatMessage;
    proposed: PendingAction[];
    asked: PendingQuestion[];
}

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
 * The note a follow-up turn is given in place of a message from the person, once they have answered
 * a question `ask_user` asked: what they chose, in their own words taken off the stored answer, never
 * a `role: 'user'` message (`ChatService.answerQuestions`). Unlike {@link followUpNote} it never
 * offers {@link NOTHING_MORE} — the agent asked because it needed this to carry on, so it always has
 * something to do with it now.
 */
export const answerNote = (question: PendingQuestion, answers: QuestionAnswer[]): string =>
    `(A note from Wilson, not from the person.) They answered the question you asked:\n${describeAnswers(question.questions, answers)}`;

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
 * The chat (`chat.ck`). A turn stores the person's message, runs the thread's engine with the five
 * chat tools (`chatTools`), and stores its answer with the operations it ran. A change the answer
 * proposed runs only through {@link decide}, and a question it asked only through
 * {@link answerQuestions} — both as the person's own act, never guessed on their behalf.
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
        private readonly attachments: ChatAttachmentRepository,
        private readonly actions: ChatPendingActionRepository,
        private readonly questions: ChatQuestionRepository,
        private readonly usage: ChatUsageRepository,
        private readonly goals: GoalRepository,
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
        const [messages, attachments, actions, questions] = await Promise.all([
            this.messages.since(id),
            this.attachments.listClaimed(id),
            this.actions.forThread(id),
            this.questions.forThread(id),
        ]);
        const byMessage = groupByMessage(attachments);
        return {
            thread: toWireThread(thread),
            messages: messages.map(message => toWireMessage(message, byMessage.get(message.seq))),
            actions: actions.map(toWireAction),
            questions: questions.map(toWireQuestion),
        };
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

    async sendMessage(id: string, { text, project, attachments = [] }: SendChatMessageRequest): Promise<ChatTurnResult> {
        const said = text.trim();
        const attachmentIds = [...new Set(attachments)];
        if (!said && attachmentIds.length === 0) throw httpError(400).withDetails({ reason: 'a message needs some text or an image' });
        if (attachmentIds.length > MAX_IMAGES_PER_MESSAGE) {
            throw httpError(400).withDetails({ reason: `a message can carry at most ${MAX_IMAGES_PER_MESSAGE} images` });
        }
        if (attachmentIds.some(attachmentId => !parseAttachmentId(attachmentId))) {
            throw httpError(400).withDetails({ reason: 'an attachment id on this message is not one' });
        }
        await this.threadOrThrow(id);
        const session = this.session();

        return threadLock(id).run(
            `message to chat thread ${id}`,
            message => this.logger.info(message),
            async () => {
                const thread = await this.threadOrThrow(id);
                // Checked here, inside the lock, because a message this one waited for may have used them.
                const uploads = await this.attachments.readUnclaimed(id, attachmentIds);
                if (uploads.length !== attachmentIds.length) {
                    throw httpError(400).withDetails({ reason: 'an image on this message was already sent, or is not in this thread' });
                }
                // An ordinary message supersedes whatever the agent was still waiting to hear back on.
                await this.questions.dismissPending(id);
                const history = await this.messages.since(id);
                if (history.length === 0 && thread.title === NEW_THREAD_TITLE) await this.threads.rename(id, titleFrom(said) || IMAGE_THREAD_TITLE);
                const message = await this.messages.append(id, { role: 'user', content: said, attachmentIds });

                const { reply, proposed, asked } = await this.answer(thread, history, said, session, project, { images: uploads.map(toImage) });
                return {
                    message: toWireMessage(message, uploads),
                    reply: toWireMessage(reply!),
                    proposed: proposed.map(toWireAction),
                    asked: asked.map(toWireQuestion),
                };
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

    /**
     * Answer a question `ask_user` asked: 404 for an unknown thread, an unknown question, or one that
     * belongs to another thread (one 404 covers all three — `chat.ck`'s own comment on why); 400 for a
     * submission {@link validateAnswers} refuses; 409 for one already answered, already dismissed, or
     * past its `expiresAt`. A valid submission starts a follow-up turn carrying what was chosen
     * ({@link followUpQuestions}), not awaited here, exactly as {@link decide} starts its own.
     */
    async answerQuestions(id: string, questionId: string, { answers }: AnswerChatQuestionsRequest): Promise<WirePendingQuestion> {
        await this.threadOrThrow(id);
        const question = await this.questions.get(questionId);
        if (!question || question.threadId !== id) throw httpError(404).withDetails({ reason: `chat question ${questionId} not found` });

        const reason = validateAnswers(question.questions, answers);
        if (reason) throw httpError(400).withDetails({ reason });

        const answered = await this.questions.answer(questionId, answers);
        if (!answered) throw httpError(409).withDetails({ reason: this.whyUnanswerable(question) });

        this.followUpQuestions(answered, answers, this.session());
        return toWireQuestion(answered);
    }

    /**
     * Run one turn on `threadId`, told `note` in place of a message from a person, and resolve once it
     * is finished. Takes the thread's lock, so a message sent meanwhile waits for it rather than racing
     * it. `note` is never stored as anyone's message, and a turn answering {@link NOTHING_MORE} stores
     * no answer either.
     *
     * Takes `session` rather than reading the request's, so it can run where there is no request. Every
     * operation in the turn runs as that session. Rejects when the turn fails, which the turn has also
     * published as `failed`. Resolves with `undefined` for a thread that does not exist.
     */
    async runNote(
        threadId: string,
        note: string,
        session: AuthenticationSession,
        project?: string,
        { maxSteps }: { maxSteps?: number } = {},
    ): Promise<NoteOutcome | undefined> {
        return threadLock(threadId).run(
            `note to chat thread ${threadId}`,
            message => this.logger.info(message),
            async () => {
                const thread = await this.threads.get(threadId);
                if (!thread) return undefined;
                const history = await this.messages.since(thread.id);
                return this.answer(thread, history, note, session, project, { followUp: true, maxSteps });
            },
        );
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
        this.inBackground(this.runNote(action.threadId, followUpNote(action), session, action.project), `chat action ${action.id}`);
    }

    /**
     * After an answered question, give the chat a turn of its own to carry on, told what the person
     * chose ({@link answerNote}) in place of a message from them. `followUp: true` for
     * {@link answer}'s `engineMessages` head-prepending, the same as {@link followUp}'s own call; the
     * `NOTHING_MORE` branch it also guards never fires here, since {@link answerNote} never asks for
     * that token. Tracked in `this.followUps` so `whenIdle` covers it, and takes the thread's lock so a
     * message sent meanwhile waits for it rather than racing it, the same as {@link followUp}.
     */
    private followUpQuestions(question: PendingQuestion, answers: QuestionAnswer[], session: AuthenticationSession): void {
        this.inBackground(this.runNote(question.threadId, answerNote(question, answers), session), `chat question ${question.id}`);
    }

    /** Let `work` finish after its request has, logging a failure rather than throwing it, and tracked so `whenIdle` covers it. */
    private inBackground(work: Promise<unknown>, about: string): void {
        const run: Promise<void> = work
            .then(() => undefined)
            .catch(err => this.logger.warn(`${about}: the follow-up failed: ${explainError(err)}`))
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
        { followUp = false, images, maxSteps }: { followUp?: boolean; images?: ChatImage[]; maxSteps?: number } = {},
    ): Promise<NoteOutcome> {
        const fail = (reason: string): never => {
            publishChat(thread.id, { event: 'failed', data: { reason } });
            throw httpError(503).withDetails({ reason });
        };

        const engine = this.engines[thread.engine];
        if (!engine) return fail(`the chat could not answer: the '${thread.engine}' engine is not available`);

        const { provider, model } = await this.choose();
        const projects = (await this.projects.list()).map(row => row.name);
        const [goal] = await this.goals.list({ threadId: thread.id });
        const context: ChatTurnContext = {
            threadId: thread.id,
            container: this.container,
            logger: this.logger,
            session,
            operations: [],
            proposed: [],
            asked: [],
            emit: event => publishChat(thread.id, toStreamEvent(event)),
        };

        let output;
        try {
            output = await engine.turn({
                thread,
                history: await this.withImages(thread, history),
                text,
                images,
                system: chatSystemPrompt({ projects, currentProject: project, threadId: thread.id, goal }),
                tools: chatTools(this.catalog, context),
                provider,
                model,
                // What keeps a turn from changing anything is that it holds only `chatTools`, so a turn
                // whose engine offers or attempts anything else fails rather than carrying on.
                onlyOwnTools: true,
                maxSteps,
                onText: delta => publishChat(thread.id, { event: 'delta', data: delta }),
            });
        } catch (err) {
            this.logger.warn(`chat thread ${thread.id}: the turn failed: ${explainError(err)}`);
            return fail(`the chat could not answer: ${explainError(err)}`);
        }

        if (output.usage) {
            // Recorded before anything below can stop the turn, because a silent turn stores no message.
            // The answer is already paid for, so failing to count it must not lose it.
            await this.usage
                .record(thread.id, { engine: thread.engine, model, usage: output.usage })
                .catch(err => this.logger.warn(`chat thread ${thread.id}: could not record the turn's usage: ${explainError(err)}`));
        }
        if (output.engineSessionId) await this.threads.setEngineSessionId(thread.id, output.engineSessionId);
        const { text: written, suggestions } = splitSuggestions(output.text.trim());
        if (followUp && written === NOTHING_MORE && context.proposed.length === 0) {
            publishChat(thread.id, { event: 'done', data: { seq: history.at(-1)?.seq ?? 0 } });
            return { proposed: [], asked: [] };
        }
        const reply = await this.messages.append(thread.id, {
            role: 'assistant',
            content: written.replace(NOTHING_MORE, '').trim() || '(no answer)',
            operations: context.operations,
            // What to ask next follows once the person has decided, not while a change waits on them —
            // or while a question they asked still waits on the person.
            suggestions: context.proposed.length === 0 && context.asked.length === 0 ? suggestions : [],
            // A follow-up's note is not stored as a message, so the 'api' engine keeps it at the head
            // of the answer's own record: replayed next turn, the answer still follows what prompted it
            // rather than a second answer in a row.
            engineMessages:
                followUp && Array.isArray(output.engineMessages)
                    ? [{ role: 'user', content: text }, ...output.engineMessages]
                    : output.engineMessages,
        });
        publishChat(thread.id, { event: 'done', data: { seq: reply.seq } });
        return { reply, proposed: context.proposed, asked: context.asked };
    }

    /**
     * The thread's messages as an engine takes them: each says how many images it carried, and on the
     * engine that replays, the most recent {@link REPLAYED_IMAGE_MESSAGES} that have any bring their
     * bytes. The 'cli' engine resumes a session that already holds them.
     */
    private async withImages(thread: ChatThread, history: ChatMessage[]): Promise<ChatTurnHistory[]> {
        const seen = new Set(history.map(message => message.seq));
        const carried = (await this.attachments.listClaimed(thread.id)).filter(attachment => seen.has(attachment.messageSeq!));
        if (carried.length === 0) return history;

        const counts = groupByMessage(carried);
        const replayed = thread.engine === 'api' ? [...counts.keys()].sort((a, b) => a - b).slice(-REPLAYED_IMAGE_MESSAGES) : [];
        const bytes = groupByMessage(await this.attachments.readForMessages(thread.id, replayed));
        return history.map(message => ({
            ...message,
            imageCount: counts.get(message.seq)?.length ?? 0,
            images: bytes.get(message.seq)?.map(toImage),
        }));
    }

    private whyUndecidable(action: PendingAction): string {
        if (action.status !== 'pending') return `chat action ${action.id} was already decided (${action.status})`;
        return `chat action ${action.id} expired before it was decided; ask for it again`;
    }

    private whyUnanswerable(question: PendingQuestion): string {
        if (question.status !== 'pending') return `chat question ${question.id} was already ${question.status}`;
        return `chat question ${question.id} expired before it was answered; ask again`;
    }

    private async threadOrThrow(id: string): Promise<ChatThread> {
        const thread = await this.threads.get(id);
        if (!thread) throw httpError(404).withDetails({ reason: `chat thread ${id} not found` });
        return thread;
    }
}
