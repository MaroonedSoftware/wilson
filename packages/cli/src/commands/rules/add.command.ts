import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

interface AddOpts {
    severity?: 'blocker' | 'concern';
    message?: string;
}

/**
 * Add a checked rule: `wilson rules add no-raw-sql "Queries go through Kysely" 'apps/api/src/**'`. Each
 * rule matching a card's diff gets its own model call at review, so a narrow glob costs less. Validated
 * by the API. The save asks for the password (`withStepUp`).
 */
const command: CommandModule<AddOpts> = {
    description: 'Add a checked rule',
    args: [
        { name: 'id', description: 'A short name: lower-case letters, digits and hyphens', required: true },
        { name: 'statement', description: 'What must hold in the code', required: true },
        { name: 'paths', description: 'Globs of the files it is about; "**" for every file', required: true, variadic: true },
    ],
    options: [
        { flags: '--severity <severity>', description: 'blocker (default) can send a card back; concern only reports', type: 'string' },
        { flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' },
    ],
    run: withApi<AddOpts>(async (opts, ctx, args, api) => {
        const [id, statement, ...paths] = args.flat().map(String);
        await withStepUp(ctx, api, client =>
            client.rules.createRule({
                id: id!,
                statement: statement!,
                paths,
                ...(opts.severity ? { severity: opts.severity } : {}),
                ...(opts.message ? { message: opts.message } : {}),
            }),
        );
        ctx.logger.info(`${id}: added`);
        return 0;
    }),
};

export default command;
