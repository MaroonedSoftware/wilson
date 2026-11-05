import type { CommandModule } from '@maroonedsoftware/johnny5';
import type { McpToolAccess } from '@wilson/sdk';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';
import { connectionLine } from './print.js';

interface ReviewOpts {
    read?: string;
    change?: string;
    disable?: string;
}

const names = (list: string | undefined): string[] =>
    (list ?? '')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);

/**
 * Decide how tools may be used (`PUT /api/mcp-connections/{name}/tools`), approving what each is
 * described as now. A read runs without asking, so mark one only if it truly changes nothing: the
 * server's own hint is not checked and cannot be.
 */
const command: CommandModule = {
    description: 'Decide how tools may be used: reads run without asking, changes wait for a person to confirm them',
    args: [{ name: 'name', description: 'The connection', required: true }],
    options: [
        { flags: '--read <tools>', description: 'Comma-separated tools that only read, which run without asking', type: 'string' },
        { flags: '--change <tools>', description: 'Comma-separated tools that change something, which a person confirms each time', type: 'string' },
        { flags: '--disable <tools>', description: 'Comma-separated tools never to offer', type: 'string' },
    ],
    run: withApi<ReviewOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);
        const decided = (list: string | undefined, access: McpToolAccess) => names(list).map(tool => ({ name: tool, access }));
        const tools = [...decided(opts.read, 'read'), ...decided(opts.change, 'change'), ...decided(opts.disable, 'disabled')];
        if (tools.length === 0) {
            ctx.logger.error('name at least one tool with --read, --change or --disable; `wilson mcp tools` shows them');
            return 1;
        }
        if (new Set(tools.map(tool => tool.name)).size !== tools.length) {
            ctx.logger.error('a tool can only be given one of --read, --change and --disable');
            return 1;
        }
        const saved = await withStepUp(ctx, api, client => client.mcpConnections.reviewMCPTools(name, { tools }));
        ctx.logger.info(connectionLine(saved));
        return 0;
    }),
};

export default command;
