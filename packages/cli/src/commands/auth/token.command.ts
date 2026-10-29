import type { CliContext, CommandModule } from '@maroonedsoftware/johnny5';
import { resolveApiBase } from '../../api-client.js';
import { keyStoreFor, resolveToken, type KeyStore } from '../../credentials.js';

/**
 * Print this machine's API key, for a one-off `curl -H "Authorization: Bearer $(wilson auth token)"`.
 * Written to stdout alone, with nothing around it, so it can be captured.
 */
export const token = async (
    ctx: CliContext,
    store?: KeyStore,
    write: (text: string) => void = text => process.stdout.write(text),
): Promise<number> => {
    const value = await resolveToken(ctx, store ?? keyStoreFor(ctx, resolveApiBase(ctx)));
    if (!value) {
        ctx.logger.error('not signed in; run `wilson auth login`');
        return 1;
    }
    write(`${value}\n`);
    return 0;
};

const command: CommandModule<Record<string, never>> = {
    description: "Print this machine's API key",
    run: (_opts, ctx) => token(ctx),
};

export default command;
