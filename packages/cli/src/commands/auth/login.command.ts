import { hostname } from 'node:os';
import { isCancel, password as promptPassword, text as promptText } from '@clack/prompts';
import type { CliContext, CommandModule } from '@maroonedsoftware/johnny5';
import { SdkError, WilsonSdk } from '@wilson/sdk';
import { describeApiError, resolveApiBase } from '../../api-client.js';
import { keyStoreFor, type KeyStore } from '../../credentials.js';
import { apiSettings } from '../../settings.js';

interface LoginOpts {
    username?: string;
    passwordStdin?: boolean;
}

/** What to ask for, or how to read it, so tests can answer without a terminal. */
export interface LoginIo {
    ask: (message: string) => Promise<string | undefined>;
    askSecret: (message: string) => Promise<string | undefined>;
    readStdin: () => Promise<string>;
}

const readAll = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
};

const terminalIo: LoginIo = {
    ask: async message => {
        const answer = await promptText({ message });
        return isCancel(answer) ? undefined : answer;
    },
    askSecret: async message => {
        const answer = await promptPassword({ message });
        return isCancel(answer) ? undefined : answer;
    },
    readStdin: readAll,
};

/**
 * Sign this machine in: the operator's username and password buy a short-lived session, the session
 * mints a `manage` API key named for this host, the key goes into the OS keyring, and the session
 * is signed out again. Every later command sends the key (`api-client.ts`), so the password is
 * typed once per machine, not once per command, and is never stored.
 *
 * A key rather than the session's own tokens: a key is revocable by name from anywhere
 * (`/api/auth/keys`), it does not need refreshing, and it is what a script would use anyway.
 * Signing in again replaces the stored key and revokes the one it replaces.
 *
 * `--password-stdin` reads the password from stdin for a non-interactive login, as `docker login`
 * does, so it never has to appear in a process list or shell history.
 */
export const login = async (opts: LoginOpts, ctx: CliContext, io: LoginIo = terminalIo, store?: KeyStore): Promise<number> => {
    const baseUrl = resolveApiBase(ctx);
    const keys = store ?? keyStoreFor(ctx, baseUrl);

    const username = opts.username ?? (await io.ask('Username'));
    const password = opts.passwordStdin ? (await io.readStdin()).replace(/\r?\n$/, '') : await io.askSecret('Password');
    if (!username || !password) {
        ctx.logger.error('a username and a password are needed to sign in');
        return 1;
    }

    // Unsigned: this is how a credential is obtained, so none is sent.
    const anonymous = new WilsonSdk({ baseUrl, headers: apiSettings(ctx).project ? { 'X-Wilson-Project': apiSettings(ctx).project! } : undefined });
    let accessToken: string;
    try {
        ({ accessToken } = await anonymous.auth.requestToken({ grant_type: 'password', username, password }));
    } catch (err) {
        if (err instanceof SdkError && err.status === 401) ctx.logger.error('wrong username or password');
        else if (err instanceof SdkError && err.status === 429) ctx.logger.error('too many wrong passwords; wait five minutes and try again');
        else ctx.logger.error(describeApiError(err, ctx));
        return 1;
    }

    const session = new WilsonSdk({ baseUrl, headers: { Authorization: `Bearer ${accessToken}` } });
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
