import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface AddOpts {
    attempt?: number;
}

/** Keep a past stage attempt to run again (`POST /api/evals/fixtures`). Nothing about the card changes. */
const command: CommandModule<AddOpts> = {
    description: 'Capture a past stage attempt as an eval fixture',
    args: [
        { name: 'card', description: 'The card the attempt belongs to', required: true },
        { name: 'stage', description: 'implementing, testing or review', required: true },
    ],
    options: [{ flags: '--attempt <n>', description: 'Which attempt, counting from 1. Defaults to the latest', type: 'number' }],
    run: withApi<AddOpts>(async (opts, ctx, args, api) => {
        const fixture = await api.evals.captureEvalFixture({
            cardId: String(args[0]),
            stage: String(args[1]),
            ...(opts.attempt !== undefined && { attempt: opts.attempt }),
        });
        ctx.logger.info(
            `fixture ${fixture.id}: ${fixture.sourceCardId} ${fixture.stage} at ${fixture.headSha.slice(0, 8)}, from ${fixture.baseSha.slice(0, 8)}`,
        );
        for (const warning of fixture.warnings) ctx.logger.warn(warning);
        return 0;
    }),
};

export default command;
