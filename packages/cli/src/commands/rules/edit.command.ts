import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

interface EditOpts {
    statement?: string;
    severity?: 'blocker' | 'concern';
    message?: string;
}

/**
 * Change a checked rule. Only what is given changes, and any globs given replace the old ones. A change
 * makes every earlier verdict about the rule stop counting, so the next review judges it again. The
 * save asks for the password (`withStepUp`).
 */
const command: CommandModule<EditOpts> = {
    description: 'Change a checked rule',
    args: [
        { name: 'id', description: 'The rule to change', required: true },
        { name: 'paths', description: 'New globs, replacing the old ones', variadic: true },
    ],
    options: [
        { flags: '--statement <text>', description: 'What must hold in the code', type: 'string' },
        { flags: '--severity <severity>', description: 'blocker can send a card back; concern only reports', type: 'string' },
        { flags: '-m, --message <text>', description: 'What this change is, for the history', type: 'string' },
    ],
    run: withApi<EditOpts>(async (opts, ctx, args, api) => {
        const [id, ...paths] = args.flat().map(String);
        if (paths.length === 0 && opts.statement === undefined && opts.severity === undefined) {
            ctx.logger.error('give a new --statement, --severity or globs');
            return 1;
        }
        await withStepUp(ctx, api, client =>
            client.rules.updateRule(id!, {
                ...(paths.length > 0 ? { paths } : {}),
                ...(opts.statement !== undefined ? { statement: opts.statement } : {}),
                ...(opts.severity ? { severity: opts.severity } : {}),
                ...(opts.message ? { message: opts.message } : {}),
            }),
        );
        ctx.logger.info(`${id}: changed`);
        return 0;
    }),
};

export default command;
