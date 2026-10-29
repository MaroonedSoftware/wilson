import { Injectable, type Container } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import type { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { runAsProject } from '#modules/board/project.context.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { McpToolCatalog } from '#modules/mcp/generated/mcp.tools.js';

/** One catalog operation as the chat's tools see it. */
export interface ChatCatalogEntry {
    name: string;
    description: string;
    /** True for a read, which the chat may run without asking; false for a change, which it may only propose. */
    readOnly: boolean;
    /** The operation's arguments as JSON Schema: path params, `body`, and query params by name. */
    inputSchema: unknown;
}

/**
 * The sentence a failed operation is explained with. A refusal carries its own in `details.reason`
 * (`httpError(400).withDetails({ reason })` throughout the board); a validation failure carries its
 * field errors in `details`; anything else has only its message.
 */
export const explainError = (err: unknown): string => {
    const details = (err as { details?: Record<string, unknown> }).details;
    if (typeof details?.reason === 'string') return details.reason;
    const message = err instanceof Error ? err.message : String(err);
    return details ? `${message}: ${JSON.stringify(details)}` : message;
};

/**
 * The operation catalog (`McpModule`), as the chat reaches it: searched by keyword, described by
 * name, and run in the project an operation is for.
 *
 * Running an operation does what an HTTP request does. `ProjectContextRouter` (`routes.setup.ts`)
 * checks a named project against `runner.projects`, registers its row, and runs the request inside
 * `runAsProject`; {@link run} does the same, so a catalog handler reads `BoardConfig` exactly as the
 * route it mirrors would. Each call gets its own scoped container, as each request does, which is
 * where the handler resolves its service (`resolve: perCall`).
 */
@Injectable()
export class ChatCatalog {
    private readonly entries: ChatCatalogEntry[];

    constructor(private readonly catalog: McpToolCatalog) {
        this.entries = [...catalog].map(([name, handler]) => ({
            name,
            description: handler.definition.description ?? handler.definition.title ?? name,
            readOnly: handler.definition.annotations?.readOnlyHint === true,
            inputSchema: handler.definition.inputSchema,
        }));
    }

    get(name: string): ChatCatalogEntry | undefined {
        return this.entries.find(entry => entry.name === name);
    }

    /**
     * Operations matching `query`, best first: each word scores twice for appearing in the name and
     * once for appearing in the description. `readOnly` narrows to reads (true) or changes (false).
     * An empty query matches everything, in catalog order.
     */
    search(query: string, limit: number, readOnly?: boolean): ChatCatalogEntry[] {
        const words = query
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
        return this.entries
            .filter(entry => readOnly === undefined || entry.readOnly === readOnly)
            .map(entry => {
                const name = entry.name.toLowerCase();
                const description = entry.description.toLowerCase();
                const score = words.reduce((sum, word) => sum + (name.includes(word) ? 2 : 0) + (description.includes(word) ? 1 : 0), 0);
                return { entry, score };
            })
            .filter(({ score }) => words.length === 0 || score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ entry }) => entry);
    }

    /**
     * Run `name` with `args` in `project` (the daemon's own when undefined, as for a request that
     * names none) and answer with its result. Throws what the operation throws, and a 400 for a
     * project that is not registered or an operation that does not exist.
     */
    async run(container: Container, logger: Logger, name: string, args: Record<string, unknown>, project?: string): Promise<unknown> {
        const handler = this.catalog.get(name);
        if (!handler) throw httpError(400).withDetails({ reason: `there is no operation named "${name}"` });

        const scope = container.createScopedContainer();
        const board = scope.get(BoardConfig);
        if (project) {
            const row = await scope.get(ProjectRepository).find(project);
            if (!row) throw httpError(400).withDetails({ reason: `project "${project}" is not registered` });
            board.register(row);
        }

        const result = await runAsProject(project ?? board.project, () =>
            handler.handle(args, { requestId: `chat:${name}`, logger, container: scope, toolName: name }),
        );
        if (result.structuredContent !== undefined) return result.structuredContent;
        const text = result.content?.find(part => part.type === 'text')?.text;
        if (text === undefined || text === 'OK') return null;
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
}
