import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { withStepUp } from '../../sign.in.js';

interface TokenOpts {
    revoke?: boolean;
}

/**
 * Mint the token a worker host's worker program connects with (`POST /api/hosts/{name}/worker-token`),
 * replacing any it had, or with `--revoke` forget it (`DELETE`). The token is printed once and kept
 * nowhere: only its hash is stored, so a lost one is replaced by minting again.
 *
 * Minting asks for the password (`withStepUp`): whatever holds the token is sent repository contents
 * and engine tokens, so a leaked API key must not be able to mint one. Revoking needs only the key.
 */
const command: CommandModule<TokenOpts> = {
    description: "Mint (or revoke) the token a worker host's worker program connects with",
    args: [{ name: 'name', description: 'The worker host name', required: true }],
    options: [{ flags: '--revoke', description: 'Forget the host’s token, so nothing can connect as it', type: 'boolean' }],
    run: withApi<TokenOpts>(async (opts, ctx, args, api) => {
        const name = String(args[0]);
        if (opts.revoke) {
            await api.hosts.revokeWorkerToken(name);
            ctx.logger.info(`${name}'s worker token revoked; nothing can connect as it until a new one is minted`);
            return 0;
        }
        const issued = await withStepUp(ctx, api, client => client.hosts.mintWorkerToken(name));
        ctx.logger.info(issued.token);
        ctx.logger.info(
            `Give this to ${name}'s worker as WILSON_WORKER_TOKEN. It is not shown again; any earlier token for ${name} no longer works.`,
        );
        return 0;
    }),
};

export default command;
