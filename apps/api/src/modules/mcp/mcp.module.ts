import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { McpToolCatalog, registerMcpCatalog, registerMcpToolClasses } from './generated/mcp.tools.js';

/**
 * The operation catalog: one generated handler per contract operation (`contractkit.config.json`'s
 * `mcp.catalog`), each named after its operation, described from the `.ck` file, flagged read-only
 * from its HTTP method, and calling the same service the HTTP router does. Nothing lists it and no
 * route serves it — there is no `POST /mcp` here. It is what the chat's meta tools look an operation
 * up in, so the chat reaches the board through the same typed layer every other client does
 * (PROJECT.md decision 3) rather than through a second set of hand-written tools.
 *
 * Each handler resolves its service per call from the container on its `McpToolContext`
 * (`resolve: perCall`), the way a route resolves one from `ctx.container`.
 */
export const McpModule: ServerKitModule = {
    name: 'Mcp',
    setup: async (registry: Registry, _: AppConfig) => {
        registerMcpToolClasses(registry);
        registry.register(McpToolCatalog).useFactory(registerMcpCatalog).asSingleton();
    },
};
