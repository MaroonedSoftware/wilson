import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';
import { connectionLine, toolLines } from './print.js';

interface AddOpts {
    secret?: string;
    project?: string;
}

/**
 * Connect to a server and list its tools (`PUT /api/mcp-connections/{name}`), replacing any connection
 * saved under that name. No tool is usable until `wilson mcp review` allows it.
 */
const command: CommandModule = {
    description: 'Connect to an MCP server over HTTP and list its tools for review',
    args: [
        { name: 'name', description: 'What to call it', required: true },
        { name: 'url', description: 'Its http or https address', required: true },
    ],
    options: [
        { flags: '--secret <name>', description: 'The saved secret to send as its bearer token (`wilson secret set`)', type: 'string' },
        { flags: '--project <name>', description: 'The one project it may be used in (default: any)', type: 'string' },
    ],
    run: withApi<AddOpts>(async (opts, ctx, args, api) => {
        const [name, url] = [String(args[0]), String(args[1])];
        const saved = await withStepUp(ctx, api, client =>
            client.mcpConnections.putMCPConnection(name, {
                url,
                ...(opts.secret !== undefined && { secret: opts.secret }),
                ...(opts.project !== undefined && { project: opts.project }),
            }),
        );
        ctx.logger.info(connectionLine(saved));
        if (opts.secret !== undefined && url.startsWith('http://')) {
            ctx.logger.warn(`${opts.secret} will be sent over plain http: use this only on a network you trust.`);
        }
        for (const line of toolLines(saved)) ctx.logger.info(line);
        ctx.logger.info(`Nothing is usable yet: \`wilson mcp review ${name} --read <tools> --change <tools> --disable <tools>\` decides.`);
        return 0;
    }),
};

export default command;
