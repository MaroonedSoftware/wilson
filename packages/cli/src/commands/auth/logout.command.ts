import type { CliContext, CommandModule } from '@maroonedsoftware/johnny5';
import { apiClient, describeApiError, resolveApiBase } from '../../api-client.js';
import { keyStoreFor, type KeyStore } from '../../credentials.js';

/**
 * Sign this machine out: revoke its API key on the server, then forget it locally. The local copy
 * is removed even when the server cannot be reached, since a key the operator no longer wants should
 * not keep working from this machine; the warning says to revoke it from the web app instead.
 */
export const logout = async (ctx: CliContext, store?: KeyStore): Promise<number> => {
    const keys = store ?? keyStoreFor(ctx, resolveApiBase(ctx));
    const stored = await keys.read();
    if (!stored) {
        ctx.logger.info('not signed in');
        return 0;
    }
    try {
        await apiClient(ctx, keys).apiKeys.revokeApiKey(stored.id);
    } catch (err) {
        ctx.logger.warn(`could not revoke "${stored.name}" on the server (${describeApiError(err, ctx)}); revoke it from the web app`);
    }
    await keys.clear();
    ctx.logger.info('signed out');
    return 0;
};

const command: CommandModule<Record<string, never>> = {
    description: 'Sign this machine out, revoking its API key',
    run: (_opts, ctx) => logout(ctx),
};

export default command;
