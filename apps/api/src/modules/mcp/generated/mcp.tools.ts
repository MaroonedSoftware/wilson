import { Injectable, type Container, type Registry } from 'injectkit';
import { McpToolHandlerMap } from '@maroonedsoftware/mcp';
import { registerBoardMcpCatalog, registerBoardMcpToolClasses } from './board.mcp.js';
import { registerContextMcpCatalog, registerContextMcpToolClasses } from './context.mcp.js';
import { registerHealthMcpCatalog, registerHealthMcpToolClasses } from './health.mcp.js';
import { registerHostsMcpCatalog, registerHostsMcpToolClasses } from './hosts.mcp.js';
import { registerLearningsMcpCatalog, registerLearningsMcpToolClasses } from './learnings.mcp.js';
import { registerProjectsMcpCatalog, registerProjectsMcpToolClasses } from './projects.mcp.js';
import { registerSettingsMcpCatalog, registerSettingsMcpToolClasses } from './settings.mcp.js';
import { registerStagesMcpCatalog, registerStagesMcpToolClasses } from './stages.mcp.js';

/**
 * Build the MCP tool map: the tools `tools/list` reports.
 *
 * Bind it to the `McpToolHandlerMap` token from a factory, which is what supplies the
 * `Container` needed to resolve each handler:
 *
 * ```ts
 * registry.register(McpToolHandlerMap).useFactory(registerMcpTools).asSingleton();
 * ```
 */
export function registerMcpTools(_container: Container): McpToolHandlerMap {
    const map = new McpToolHandlerMap();
    return map;
}

/**
 * A handler for every operation a tool can serve, flagged `mcp:` or not, kept apart from the
 * listed tools. Its own token, since `McpToolHandlerMap` is bound to `registerMcpTools`.
 */
@Injectable()
export class McpToolCatalog extends McpToolHandlerMap {}

/**
 * Build the catalog. Nothing lists it: a meta tool (one that searches the API, say) looks a
 * handler up by name and calls it. Bind it from a factory, as `registerMcpTools` is bound:
 *
 * ```ts
 * registry.register(McpToolCatalog).useFactory(registerMcpCatalog).asSingleton();
 * ```
 */
export function registerMcpCatalog(container: Container): McpToolCatalog {
    const map = new McpToolCatalog();
    registerBoardMcpCatalog(map, container);
    registerContextMcpCatalog(map, container);
    registerHealthMcpCatalog(map, container);
    registerHostsMcpCatalog(map, container);
    registerLearningsMcpCatalog(map, container);
    registerProjectsMcpCatalog(map, container);
    registerSettingsMcpCatalog(map, container);
    registerStagesMcpCatalog(map, container);
    return map;
}

/**
 * Register every generated tool class on the registry, so the tool maps can resolve them:
 *
 * ```ts
 * registerMcpToolClasses(registry);
 * ```
 */
export function registerMcpToolClasses(registry: Registry): void {
    registerBoardMcpToolClasses(registry);
    registerContextMcpToolClasses(registry);
    registerHealthMcpToolClasses(registry);
    registerHostsMcpToolClasses(registry);
    registerLearningsMcpToolClasses(registry);
    registerProjectsMcpToolClasses(registry);
    registerSettingsMcpToolClasses(registry);
    registerStagesMcpToolClasses(registry);
}
