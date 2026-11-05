import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/** Remove an eval fixture and the refs keeping its commits (`DELETE /api/evals/fixtures/{id}`). */
const command: CommandModule = {
    description: 'Remove an eval fixture',
    args: [{ name: 'id', description: 'The fixture id', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const id = String(args[0]);
        await api.evals.removeEvalFixture(id);
        ctx.logger.info(`fixture ${id} removed`);
        return 0;
    }),
};

export default command;
