import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { describeHost } from '../../host-view.js';

interface ServeOpts {
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
}

/**
 * Say where a project lives on a host, so stages of that project can be placed there
 * (`PUT /api/hosts/{name}/projects/{project}`). All three paths are on the host, not this machine:
 * `--code-root` is the project's clone there, which worktrees are cut from. A second call replaces
 * the first.
 */
const command: CommandModule<ServeOpts> = {
    description: 'Let a host run stages for a project, and say where its clone is there',
    args: [
        { name: 'name', description: 'The host name', required: true },
        { name: 'project', description: 'The registered project', required: true },
    ],
    options: [
        { flags: '--code-root <path>', description: "Absolute path of the project's clone on the host", type: 'string', required: true },
        { flags: '--worktree-root <path>', description: 'Absolute path on the host where card worktrees are cut', type: 'string', required: true },
        { flags: '--run-root <path>', description: 'Absolute path on the host for plans and run state', type: 'string', required: true },
    ],
    run: withApi<ServeOpts>(async (opts, ctx, args, api) => {
        const host = await api.hosts.setHostProject(String(args[0]), String(args[1]), {
            codeRoot: opts.codeRoot,
            worktreeRoot: opts.worktreeRoot,
            runRoot: opts.runRoot,
        });
        for (const line of describeHost(host)) ctx.logger.info(line);
        return 0;
    }),
};

export default command;
