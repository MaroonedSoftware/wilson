import { InjectKitRegistry, type Container } from 'injectkit';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import type { McpToolHandler } from '@maroonedsoftware/mcp';
import { DateTime } from 'luxon';
import { BoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import { currentProject } from '#modules/board/project.context.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { ChatCatalog } from '#modules/chat/chat.catalog.js';
import { ChatPendingActionRepository, type NewPendingAction, type PendingAction } from '#modules/chat/chat.pending.action.repository.js';
import type { ChatTurnContext } from '#modules/chat/chat.tools.js';
import { McpToolCatalog } from '#modules/mcp/generated/mcp.tools.js';

/** One call a fake catalog handler received: its arguments, and the project it ran in. */
export interface FakeCall {
    name: string;
    args: Record<string, unknown>;
    project: string | undefined;
}

/**
 * A catalog handler that answers `result` (or throws `fails`), recording each call with the project
 * `runAsProject` had open — the one thing a real handler's service reads from `BoardConfig`.
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
    handle: async args => {
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

/**
 * A container with what `ChatCatalog.run` and the tools resolve: a board fixed to `default-project`,
 * a project repository that knows only `wilson` and `other`, and the given pending-action repository.
 */
export const fakeContainer = (proposals: ChatPendingActionRepository = fakeProposals().repository): Container => {
    const registry = new InjectKitRegistry();
    registry.register(BoardConfig).useValue(new StaticBoardConfig('default-project', '/tmp/code', '/tmp/wt', '/tmp/run'));
    registry.register(ProjectRepository).useValue({
        find: async (name: string) => (['wilson', 'other'].includes(name) ? { name, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' } : undefined),
    } as unknown as ProjectRepository);
    registry.register(ChatPendingActionRepository).useValue(proposals);
    return registry.build();
};

export const turnContext = (container: Container, threadId = '1'): ChatTurnContext => ({
    threadId,
    container,
    logger: new ConsoleLogger(),
    operations: [],
    proposed: [],
});
