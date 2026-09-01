import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface CreateOpts {
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
}

/**
 * Register a project — card 0168's answer to the only way this worked before: an `INSERT` by
 * hand, or restarting the daemon under a different `PROJECT_NAME` to seed a row and restarting it
 * back (see `resolveProjectRow`, board.module.ts). `POST /api/projects` does the write; this is the
 * operator's way in.
 *
 * All three paths are required and passed through unchanged — no `--code-root`-style default the
 * way `BoardModule` derives `worktreeRoot`/`runRoot` from `codeRoot` for the daemon's own seeded
 * project, since a second default site here would only drift from that one silently. No `$EDITOR`,
 * unlike `card create`: there is no prose to write, only three paths and a name. There is no board
 * root any more: the board, stage config included, is Postgres, and a new project's first stage
 * config comes from `wilson board init` (with `WILSON_PROJECT` naming it).
 *
 * Usable immediately, with no daemon restart: `Poller.tick` re-registers every project on every
 * tick, and `ProjectContextRouter` resolves `X-Wilson-Project` against Postgres directly.
 */
const command: CommandModule<CreateOpts> = {
    description: 'Register a project',
    args: [{ name: 'name', description: 'The project name', required: true }],
    options: [
        { flags: '--code-root <path>', description: 'Absolute path to the code repo', type: 'string', required: true },
        { flags: '--worktree-root <path>', description: 'Absolute path where card worktrees are cut', type: 'string', required: true },
        { flags: '--run-root <path>', description: 'Absolute path for card run state', type: 'string', required: true },
    ],
    run: withApi<CreateOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);

        await api.projects.registerProject({
            name,
            codeRoot: opts.codeRoot,
            worktreeRoot: opts.worktreeRoot,
            runRoot: opts.runRoot,
        });

        ctx.logger.info(`${name} registered`);
        return 0;
    }),
};

export default command;
