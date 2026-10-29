import type { CliContext, CommandModule } from '@maroonedsoftware/johnny5';
import { SdkError } from '@wilson/sdk';
import { apiClient, describeApiError, resolveApiBase } from '../../api-client.js';
import { keyStoreFor, resolveToken, type KeyStore } from '../../credentials.js';

/** Who this machine is signed in as, asked of the API, so a revoked or expired key shows as such. */
export const status = async (ctx: CliContext, store?: KeyStore): Promise<number> => {
    const baseUrl = resolveApiBase(ctx);
    const keys = store ?? keyStoreFor(ctx, baseUrl);
    if (!(await resolveToken(ctx, keys))) {
        ctx.logger.info(`not signed in to ${baseUrl}; run \`wilson auth login\``);
        return 1;
    }
    try {
        const session = await apiClient(ctx, keys).auth.getCurrentSession();
        ctx.logger.info(`signed in to ${baseUrl} as ${session.email}`);
        return 0;
    } catch (err) {
        if (err instanceof SdkError && err.status === 401) {
            ctx.logger.info(`the stored key no longer works at ${baseUrl}; run \`wilson auth login\``);
        } else {
            ctx.logger.error(describeApiError(err, ctx));
        }
        return 1;
    }
};

const command: CommandModule<Record<string, never>> = {
    description: 'Show who this machine is signed in to the API as',
    run: (_opts, ctx) => status(ctx),
};

export default command;
