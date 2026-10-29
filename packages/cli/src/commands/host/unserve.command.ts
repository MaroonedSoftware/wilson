import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/** Stop a host running stages for a project (`DELETE /api/hosts/{name}/projects/{project}`). */
const command: CommandModule = {
    description: 'Stop a host running stages for a project',
    args: [
        { name: 'name', description: 'The host name', required: true },
        { name: 'project', description: 'The project', required: true },
    ],
    run: withApi(async (_opts, ctx, args, api) => {
        const [name, project] = [String(args[0]), String(args[1])];
        await api.hosts.removeHostProject(name, project);
        ctx.logger.info(`${name} no longer serves ${project}`);
        return 0;
    }),
};

export default command;
