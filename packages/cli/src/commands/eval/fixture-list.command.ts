import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/** List the project's eval fixtures (`GET /api/evals/fixtures`). */
const command: CommandModule = {
    description: 'List eval fixtures',
    run: withApi(async (_opts, _ctx, _args, api) => {
        for (const fixture of await api.evals.listEvalFixtures()) {
            process.stdout.write(
                `${fixture.id.padEnd(6)} ${fixture.sourceCardId.padEnd(8)} ${fixture.stage.padEnd(14)} ${(fixture.expected ? `${fixture.expected.verdict} (${fixture.expected.source})` : '-').padEnd(18)} ${fixture.title}\n`,
            );
        }
        return 0;
    }),
};

export default command;
