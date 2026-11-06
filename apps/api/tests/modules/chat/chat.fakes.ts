import { InjectKitRegistry, type Container, type ScopedContainer } from 'injectkit';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { requireMcpAuthenticationSession, type McpToolHandler } from '@maroonedsoftware/mcp';
import type { AuthenticationSession } from '@maroonedsoftware/authentication';
import { DateTime } from 'luxon';
import { BoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import { currentProject } from '#modules/board/project.context.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { ChatAttachmentRepository, type NewChatAttachment, type StoredChatAttachmentWithBytes } from '#modules/chat/chat.attachment.repository.js';
import { ChatAttachmentService } from '#modules/chat/chat.attachment.service.js';
import { ChatCatalog } from '#modules/chat/chat.catalog.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import { McpConnectionsService } from '#modules/connections/mcp.connections.service.js';
import { ChatPendingActionRepository, type NewPendingAction, type PendingAction } from '#modules/chat/chat.pending.action.repository.js';
import { ChatQuestionRepository, type NewPendingQuestion, type PendingQuestion } from '#modules/chat/chat.question.repository.js';
import type { ChatTurnContext } from '#modules/chat/chat.tools.js';
import { McpToolCatalog } from '#modules/mcp/generated/mcp.tools.js';

/** One call a fake catalog handler received: its arguments, and the project it ran in. */
export interface FakeCall {
    name: string;
    args: Record<string, unknown>;
    project: string | undefined;
}

/** The signed-in person the chat's fakes run as. */
export const fakeSession: AuthenticationSession = {
    subject: 'account-1',
    sessionToken: 'session-1',
    issuedAt: DateTime.now(),
    lastAccessedAt: DateTime.now(),
    expiresAt: DateTime.now().plus({ hours: 1 }),
    factors: [],
    claims: {},
};

/**
 * A catalog handler that answers `result` (or throws `fails`), recording each call with the project
 * `runAsProject` had open — the one thing a real handler's service reads from `BoardConfig`. Refuses
 * a call with no session, as `requireMcpPolicy` does at the top of every generated handler.
 */
export const fakeHandler = (
    name: string,
    readOnly: boolean,
    calls: FakeCall[],
    behaviour: { result?: unknown; fails?: Error } = {},
): McpToolHandler => ({
    definition: {
        name,
        description: `${readOnly ? 'Read' : 'Change'} ${name.replaceAll('_', ' ')}`,
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        annotations: { readOnlyHint: readOnly },
    },
    handle: async (args, context) => {
        requireMcpAuthenticationSession(context);
        calls.push({ name, args, project: currentProject() });
        if (behaviour.fails) throw behaviour.fails;
        return {
            content: [{ type: 'text', text: JSON.stringify(behaviour.result ?? null) }],
            structuredContent: behaviour.result as Record<string, unknown>,
        };
    },
});

/** A refusal shaped the way the board throws them: `httpError(400).withDetails({ reason })`. */
export const refusal = (reason: string): Error => Object.assign(new Error('Bad Request'), { details: { reason } });

export const fakeCatalog = (handlers: McpToolHandler[]): ChatCatalog => {
    const catalog = new McpToolCatalog();
    for (const handler of handlers) catalog.set(handler.definition.name, handler);
    return new ChatCatalog(catalog);
};

/** Proposals a fake pending-action repository has stored. */
export const fakeProposals = (): { stored: PendingAction[]; repository: ChatPendingActionRepository } => {
    const stored: PendingAction[] = [];
    const repository = {
        findPending: async () => undefined,
        propose: async (threadId: string, action: NewPendingAction): Promise<PendingAction> => {
            const created: PendingAction = {
                id: String(stored.length + 1),
                threadId,
                project: action.project,
                operation: action.operation,
                arguments: action.arguments,
                summary: action.summary,
                status: 'pending',
                expiresAt: DateTime.now().plus(action.expiresIn),
                createdAt: DateTime.now(),
            };
            stored.push(created);
            return created;
        },
    } as unknown as ChatPendingActionRepository;
    return { stored, repository };
};

/** Questions a fake question repository has stored. */
export const fakeQuestions = (): { stored: PendingQuestion[]; repository: ChatQuestionRepository } => {
    const stored: PendingQuestion[] = [];
    const repository = {
        ask: async (threadId: string, question: NewPendingQuestion): Promise<PendingQuestion> => {
            const created: PendingQuestion = {
                id: String(stored.length + 1),
                threadId,
                questions: question.questions,
                status: 'pending',
                expiresAt: DateTime.now().plus(question.expiresIn),
                createdAt: DateTime.now(),
            };
            stored.push(created);
            return created;
        },
    } as unknown as ChatQuestionRepository;
    return { stored, repository };
};

/**
 * Images a fake attachment repository has stored, behind the real `ChatAttachmentService`, so a
 * refusal `create_image` answers is the sanitiser's own sentence and no check is copied into a test.
 * The thread repository answers every thread as existing.
 */
export const fakeChatAttachments = (): { stored: StoredChatAttachmentWithBytes[]; service: ChatAttachmentService } => {
    const stored: StoredChatAttachmentWithBytes[] = [];
    const repository = {
        insert: async (threadId: string, attachment: NewChatAttachment): Promise<StoredChatAttachmentWithBytes> => {
            const created: StoredChatAttachmentWithBytes = {
                id: String(stored.length + 1),
                threadId,
                filename: attachment.filename,
                contentType: attachment.contentType,
                byteSize: attachment.bytes.length,
                contentHash: attachment.contentHash,
                createdAt: DateTime.now(),
                bytes: attachment.bytes,
            };
            stored.push(created);
            return created;
        },
        sweepUnclaimed: async () => 0,
    } as unknown as ChatAttachmentRepository;
    const threads = { get: async () => ({}) } as unknown as ChatThreadRepository;
    return { stored, service: new ChatAttachmentService(threads, repository) };
};

/**
 * A container with what `ChatCatalog.run` and the tools resolve: a board fixed to `default-project`,
 * a project repository that knows only `wilson` and `other`, the given pending-action and
 * pending-question repositories, and the given attachment service (`create_image`'s). `configure`
 * registers anything else a test needs.
 */
export const fakeContainer = (
    proposals: ChatPendingActionRepository = fakeProposals().repository,
    questions: ChatQuestionRepository = fakeQuestions().repository,
    configure?: (registry: InjectKitRegistry) => void,
    attachments: ChatAttachmentService = fakeChatAttachments().service,
): ScopedContainer => {
    const registry = new InjectKitRegistry();
    registry.register(BoardConfig).useValue(new StaticBoardConfig('default-project', '/tmp/code', '/tmp/wt', '/tmp/run'));
    registry.register(ProjectRepository).useValue({
        find: async (name: string) => (['wilson', 'other'].includes(name) ? { name, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' } : undefined),
        list: async () => ['other', 'wilson'].map(name => ({ name, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' })),
    } as unknown as ProjectRepository);
    registry.register(ChatPendingActionRepository).useValue(proposals);
    registry.register(ChatQuestionRepository).useValue(questions);
    registry.register(ChatAttachmentService).useValue(attachments);
    registry.register(McpConnectionsService).useValue({ usableTools: async () => [] } as unknown as McpConnectionsService);
    configure?.(registry);
    return registry.build();
};

export const turnContext = (container: Container, threadId = '1'): ChatTurnContext => ({
    threadId,
    container,
    logger: new ConsoleLogger(),
    session: fakeSession,
    operations: [],
    proposed: [],
    asked: [],
    created: [],
});
