import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InjectKitRegistry, type Container } from 'injectkit';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import type { McpToolContext } from '@maroonedsoftware/mcp';
import { HealthService } from '#modules/health/health.service.js';
import { McpModule } from '#modules/mcp/mcp.module.js';
import { McpToolCatalog } from '#modules/mcp/generated/mcp.tools.js';
import { BoardRouter } from '#src/routes/board.router.js';
import { ChatRouter } from '#src/routes/chat.router.js';
import { ContextRouter } from '#src/routes/context.router.js';
import { HealthRouter } from '#src/routes/health.router.js';
import { HostsRouter } from '#src/routes/hosts.router.js';
import { LearningsRouter } from '#src/routes/learnings.router.js';
import { ProjectsRouter } from '#src/routes/projects.router.js';
import { SettingsRouter } from '#src/routes/settings.router.js';
import { StagesRouter } from '#src/routes/stages.router.js';

/**
 * The catalog the chat's meta tools look operations up in (`McpModule`). What the chat may do
 * without asking hangs on one flag: an operation is a read only when its handler says
 * `readOnlyHint: true`, and ContractKit derives that from the HTTP method. These pin the flag, that
 * the catalog covers every contract route rather than a subset, and that a handler reaches its
 * service through the call's own container (`resolve: perCall`) rather than one fixed at boot.
 */
const catalog = async (): Promise<McpToolCatalog> => {
    const registry = new InjectKitRegistry();
    await McpModule.setup!(registry, {} as AppConfig);
    return registry.build().get(McpToolCatalog);
};

const ROUTERS = [BoardRouter, ChatRouter, ContextRouter, HealthRouter, HostsRouter, LearningsRouter, ProjectsRouter, SettingsRouter, StagesRouter];

/** Every method + path the generated routers serve, `HEAD` aside (koa adds it beside each `GET`). */
const contractRoutes = (): string[] =>
    ROUTERS.flatMap(router =>
        (router as unknown as { stack: { methods: string[]; path: string }[] }).stack.flatMap(layer =>
            layer.methods.filter(method => method !== 'HEAD').map(method => `${method} ${layer.path}`),
        ),
    );

const CONTRACTS = new URL('../../../data/contracts/', import.meta.url);

/** How many operations the contracts keep out of the catalog with `mcp: exclude`. */
const excludedCount = (): number =>
    readdirSync(CONTRACTS)
        .filter(file => file.endsWith('.ck'))
        .reduce((sum, file) => sum + (readFileSync(new URL(file, CONTRACTS), 'utf8').match(/^\s*mcp: exclude\b/gm)?.length ?? 0), 0);

const readOnly = (tools: McpToolCatalog, name: string): boolean | undefined => tools.get(name)?.definition.annotations?.readOnlyHint;

const contextFor = (toolName: string, container: Container): McpToolContext => ({
    requestId: 'test',
    logger: new ConsoleLogger(),
    container,
    toolName,
});

describe('the MCP operation catalog', () => {
    it('holds one handler per contract route, except the ones a contract marks mcp: exclude', async () => {
        const tools = await catalog();

        expect(excludedCount()).toBeGreaterThan(0);
        expect(tools.size).toBe(contractRoutes().length - excludedCount());
    });

    it('leaves out what the chat must never reach, even with a confirm', async () => {
        const tools = await catalog();

        for (const name of ['record_findings', 'set_stage_config', 'set_learnings', 'send_a_plan_turn', 'open_a_planning_session']) {
            expect(tools.has(name), name).toBe(false);
        }
    });

    it('marks reads read-only', async () => {
        const tools = await catalog();

        for (const name of ['list_cards', 'get_card', 'list_card_events', 'get_card_diff', 'get_stage_config', 'list_projects']) {
            expect(readOnly(tools, name), name).toBe(true);
        }
    });

    it('marks every change as not read-only, whatever its method', async () => {
        const tools = await catalog();

        for (const name of ['create_card', 'move_card', 'edit_card_body', 'approve_card_plan', 'set_poller_setting', 'remove_a_context_snapshot']) {
            expect(readOnly(tools, name), name).toBe(false);
        }
    });

    it("calls the operation's service from the container on the call's own context", async () => {
        const health = { project: 'wilson', startedAt: '2026-01-01T00:00:00.000Z' };
        const scope = new InjectKitRegistry();
        scope.register(HealthService).useValue({ get: async () => health } as unknown as HealthService);
        const tools = await catalog();

        const result = await tools.get('get_health')!.handle({}, contextFor('get_health', scope.build()));

        expect(result.structuredContent).toEqual(health);
        expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(health) }]);
    });
});
