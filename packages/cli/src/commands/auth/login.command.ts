import type { CliContext, CommandModule } from '@maroonedsoftware/johnny5';
import { describeApiError, resolveApiBase } from '../../api-client.js';
import { keyStoreFor, type KeyStore } from '../../credentials.js';
import { signInThisMachine, SignInError, terminalIo, type LoginIo } from '../../sign.in.js';

export type { LoginIo } from '../../sign.in.js';

interface LoginOpts {
    email?: string;
    passwordStdin?: boolean;
}

/**
 * Sign this machine in (`signInThisMachine`): the operator's email address and password buy a
 * `manage` API key named for this host, kept in the OS keyring. Every later command sends the key
 * (`api-client.ts`), so the password is typed once per machine, not once per command, and is never
 * stored.
 *
 * A key rather than the session's own tokens: a key is revocable by name from anywhere
 * (`/api/auth/keys`), it does not need refreshing, and it is what a script would use anyway.
 * Signing in again replaces the stored key and revokes the one it replaces.
 *
 * `--password-stdin` reads the password from stdin for a non-interactive login, as `docker login`
 * does, so it never has to appear in a process list or shell history. With an authenticator app
 * enrolled, its code is asked for after the password (`signInWithPassword`).
 */
export const login = async (opts: LoginOpts, ctx: CliContext, io: LoginIo = terminalIo, store?: KeyStore): Promise<number> => {
    const keys = store ?? keyStoreFor(ctx, resolveApiBase(ctx));

    const email = opts.email ?? (await io.ask('Email'));
    const password = opts.passwordStdin ? (await io.readStdin()).replace(/\r?\n$/, '') : await io.askSecret('Password');
    if (!email || !password) {
        ctx.logger.error('an email and a password are needed to sign in');
        return 1;
    }

    try {
        const key = await signInThisMachine(ctx, email, password, keys, io);
        ctx.logger.info(`signed in as ${email}; this machine's key is "${key.name}" (…${key.hint})`);
        return 0;
    } catch (err) {
        ctx.logger.error(err instanceof SignInError ? err.message : describeApiError(err, ctx));
        return 1;
    }
};

const command: CommandModule<LoginOpts> = {
    description: 'Sign this machine in to the API, storing an API key in the system keyring',
    options: [
        { flags: '--email <address>', description: 'The account email address (prompted for if omitted)', type: 'string' },
        { flags: '--password-stdin', description: 'Read the password from stdin instead of prompting', type: 'boolean' },
    ],
    run: (opts, ctx) => login(opts, ctx),
};

export default command;
