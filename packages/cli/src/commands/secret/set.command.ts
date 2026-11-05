import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { terminalIo, withStepUp } from '../../sign.in.js';

/**
 * Save a secret under a name (`PUT /api/secrets/{name}`), replacing any saved there, so rotating is
 * running this again. The value comes from a hidden prompt or a pipe and never from an argument, which
 * `ps` and the shell's history would keep. Saving needs a recently proved factor, which this machine's
 * key never is, so it asks for the password (`withStepUp`).
 */
const command: CommandModule = {
    description: 'Save a secret under a name, replacing any there; reads it from a prompt or stdin',
    args: [{ name: 'name', description: 'The name to save it under', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const name = String(args[0]);
        const value = process.stdin.isTTY ? await terminalIo.askSecret(`The value for ${name}`) : await terminalIo.readStdin();
        if (value === undefined) return 1;
        await withStepUp(ctx, api, client => client.secrets.putSecret(name, { value }));
        ctx.logger.info(`${name} saved.`);
        return 0;
    }),
};

export default command;
