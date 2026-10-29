import { hostname } from 'node:os';
import type { CliContext, CommandModule } from '@maroonedsoftware/johnny5';
import { describeApiError, resolveApiBase } from '../../api-client.js';
import { keyStoreFor, type KeyStore } from '../../credentials.js';
import { sessionClient, signInWithPassword, SignInError, terminalIo, type LoginIo } from '../../sign.in.js';

export type { LoginIo } from '../../sign.in.js';

interface LoginOpts {
    username?: string;
    passwordStdin?: boolean;
}

/**
 * Sign this machine in: the operator's username and password buy a short-lived session, the session
 * mints a `manage` API key named for this host, the key goes into the OS keyring, and the session
 * is signed out again. Every later command sends the key (`api-client.ts`), so the password is
 * typed once per machine, not once per command, and is never stored.
 *
 * A key rather than the session's own tokens: a key is revocable by name from anywhere
 * (`/api/auth/keys`), it does not need refreshing, and it is what a script would use anyway.
 * Signing in again replaces the stored key and revokes the one it replaces. Minting a key needs a
 * factor proved in the last five minutes (`wilson.step.up`), which a session signed in a moment
 * ago is.
 *
 * `--password-stdin` reads the password from stdin for a non-interactive login, as `docker login`
 * does, so it never has to appear in a process list or shell history.
 */
export const login = async (opts: LoginOpts, ctx: CliContext, io: LoginIo = terminalIo, store?: KeyStore): Promise<number> => {
    const keys = store ?? keyStoreFor(ctx, resolveApiBase(ctx));

    const username = opts.username ?? (await io.ask('Username'));
    const password = opts.passwordStdin ? (await io.readStdin()).replace(/\r?\n$/, '') : await io.askSecret('Password');
    if (!username || !password) {
        ctx.logger.error('a username and a password are needed to sign in');
        return 1;
    }

    let accessToken: string;
    try {
        accessToken = await signInWithPassword(ctx, username, password);
    } catch (err) {
        ctx.logger.error(err instanceof SignInError ? err.message : describeApiError(err, ctx));
        return 1;
    }

    const session = sessionClient(ctx, accessToken);
    try {
        const previous = await keys.read();
        const issued = await session.apiKeys.createApiKey({ name: `wilson cli on ${hostname()}`, scope: 'manage' });
        if (!(await keys.write({ token: issued.token, id: issued.key.id, name: issued.key.name }))) {
            // No keyring to keep it in. Revoke it rather than leave a key nobody holds.
            await session.apiKeys.revokeApiKey(issued.key.id).catch(() => undefined);
            ctx.logger.error('could not store the API key in the system keyring; create one in the web app and set WILSON_API_KEY instead');
            return 1;
        }
        if (previous && previous.id !== issued.key.id) {
            await session.apiKeys.revokeApiKey(previous.id).catch(() => undefined);
        }
        ctx.logger.info(`signed in as ${username}; this machine's key is "${issued.key.name}" (…${issued.key.hint})`);
        return 0;
    } catch (err) {
        ctx.logger.error(describeApiError(err, ctx));
        return 1;
    } finally {
        await session.auth.logout().catch(() => undefined);
    }
};

const command: CommandModule<LoginOpts> = {
    description: 'Sign this machine in to the API, storing an API key in the system keyring',
    options: [
        { flags: '--username <name>', description: 'The account username (prompted for if omitted)', type: 'string' },
        { flags: '--password-stdin', description: 'Read the password from stdin instead of prompting', type: 'boolean' },
    ],
    run: (opts, ctx) => login(opts, ctx),
};

export default command;
