import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface LabelOpts {
    verdict: 'pass' | 'revise';
    blockers?: string;
}

/**
 * Say what a review of a fixture should find (`PUT /api/evals/fixtures/{id}/expected`), replacing what
 * the card's own review concluded. A person's word is what makes the score more than the model
 * agreeing with itself.
 */
const command: CommandModule<LabelOpts> = {
    description: 'Set what a review of an eval fixture should find',
    args: [{ name: 'id', description: 'The fixture id', required: true }],
    options: [
        { flags: '--verdict <verdict>', description: 'pass or revise', type: 'string', required: true },
        { flags: '--blockers <files>', description: 'The files a blocker should name, separated by commas', type: 'string' },
    ],
    run: withApi<LabelOpts>(async (opts, ctx, args, api) => {
        const blockerFiles = opts.blockers
            ?.split(',')
            .map(file => file.trim())
            .filter(Boolean);
        const fixture = await api.evals.setEvalFixtureExpected(String(args[0]), { verdict: opts.verdict, ...(blockerFiles && { blockerFiles }) });
        ctx.logger.info(
            `fixture ${fixture.id} should find: ${fixture.expected?.verdict}${blockerFiles?.length ? ` (${blockerFiles.join(', ')})` : ''}`,
        );
        return 0;
    }),
};

export default command;
