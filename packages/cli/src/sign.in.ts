import { hostname } from 'node:os';
import { isCancel, password as promptPassword, text as promptText } from '@clack/prompts';
import type { CliContext } from '@maroonedsoftware/johnny5';
import { SdkError, WilsonSdk } from '@wilson/sdk';
import { apiClient, describeApiError, resolveApiBase } from './api-client.js';
import type { KeyStore } from './credentials.js';
import { apiSettings } from './settings.js';

/** What to ask for, and how to read stdin, so tests can answer without a terminal. */
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

export const terminalIo: LoginIo = {
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

/** A sign-in the API refused, with the sentence to show for it. */
export class SignInError extends Error {}

const projectHeaders = (ctx: CliContext): Record<string, string> => {
    const { project } = apiSettings(ctx);
    return project ? { 'X-Wilson-Project': project } : {};
};

/** A client signed with a session's access token rather than this machine's key. */
export const sessionClient = (ctx: CliContext, accessToken: string): WilsonSdk =>
    new WilsonSdk({ baseUrl: resolveApiBase(ctx), headers: { ...projectHeaders(ctx), Authorization: `Bearer ${accessToken}` } });

/**
 * Sign in with an email and password, returning the new session's access token. Unsigned, since
 * this is how a credential is obtained. With an authenticator app enrolled, the password answers
 * `mfa_required`, and this asks for the app's code and completes the sign-in with it. Throws
 * `SignInError` with the operator-facing reason.
 */
export const signInWithPassword = async (ctx: CliContext, email: string, password: string, io: LoginIo = terminalIo): Promise<string> => {
    const anonymous = new WilsonSdk({ baseUrl: resolveApiBase(ctx), headers: projectHeaders(ctx) });
    const refused = (err: unknown, wrong: string): SignInError => {
        if (err instanceof SdkError && err.status === 401) return new SignInError(wrong);
        if (err instanceof SdkError && err.status === 429) return new SignInError('too many wrong attempts; wait five minutes and try again');
        return new SignInError(describeApiError(err, ctx));
    };

    let first;
    try {
        first = await anonymous.auth.requestToken({ grant_type: 'password', email, password });
    } catch (err) {
        throw refused(err, 'wrong email or password');
    }
    if (first.result === 'token' && first.accessToken) return first.accessToken;

    // A passkey needs a browser, so the CLI completes a sign-in only with an authenticator app.
    const factor = (first.factors ?? []).find(candidate => candidate.method === 'authenticator');
    if (!factor) {
        throw new SignInError(
            "this account's second factor is a passkey, which the CLI cannot use; set up an authenticator app as well, in the web app's Settings",
        );
    }
    const code = await io.askSecret(`Code from your authenticator app${factor.label ? ` (${factor.label})` : ''}`);
    if (!code || !first.challengeId) throw new SignInError('a code from your authenticator app is needed to sign in');
    try {
        const second = await anonymous.auth.requestToken({
            grant_type: 'authenticator',
            challenge_id: first.challengeId,
            factor_id: factor.id,
            code,
        });
        if (!second.accessToken) throw new SignInError('the API did not return a session');
        return second.accessToken;
    } catch (err) {
        if (err instanceof SignInError) throw err;
        throw refused(err, 'wrong code');
    }
};

/** The key `signInThisMachine` stored, as the API described it. */
export interface MachineKey {
    name: string;
    hint: string;
}

/**
 * Sign this machine in: the password buys a short-lived session, the session mints a `manage` API
 * key named for this host, the key goes into `keys`, and the session is signed out again. The key
 * it replaces, if any, is revoked. Minting a key needs a factor proved in the last five minutes
 * (`wilson.step.up`), which a session signed in a moment ago is.
 *
 * Throws `SignInError` for a refusal the operator can act on, and the SDK's error for anything else.
 */
export const signInThisMachine = async (
    ctx: CliContext,
    email: string,
    password: string,
    keys: KeyStore,
    io: LoginIo = terminalIo,
): Promise<MachineKey> => {
    const accessToken = await signInWithPassword(ctx, email, password, io);
    const session = sessionClient(ctx, accessToken);
    try {
        const previous = await keys.read();
        const issued = await session.apiKeys.createApiKey({ name: `wilson cli on ${hostname()}`, scope: 'manage' });
        if (!(await keys.write({ token: issued.token, id: issued.key.id, name: issued.key.name }))) {
            // No keyring to keep it in. Revoke it rather than leave a key nobody holds.
            await session.apiKeys.revokeApiKey(issued.key.id).catch(() => undefined);
            throw new SignInError('could not store the API key in the system keyring; create one in the web app and set WILSON_API_KEY instead');
        }
        if (previous && previous.id !== issued.key.id) {
            await session.apiKeys.revokeApiKey(previous.id).catch(() => undefined);
        }
        return { name: issued.key.name, hint: issued.key.hint };
    } finally {
        await session.auth.logout().catch(() => undefined);
    }
};

/** Whether the API refused a call for want of a recently proved factor (`wilson.step.up`). */
export const isStepUpRefusal = (err: unknown): boolean => {
    if (!(err instanceof SdkError) || err.status !== 403) return false;
    const kind = (err.body as { details?: { kind?: string } } | undefined)?.details?.kind;
    return kind === 'step_up_required' || kind === 'step_up_unavailable';
};

/**
 * Make `call` with `api` (this machine's key), and if the API answers that it needs a recently
 * proved factor, ask for the password and make it once more with a fresh session, signed out again
 * straight after. That is how `wilson stages edit|set` save and how the `wilson host` commands that
 * say which machine receives card work do theirs: an API key never satisfies `wilson.step.up`
 * (PROJECT.md, Authentication: Factors), so a leaked key can do neither, and the operator types the password at the moment it matters instead of on every command.
 *
 * The email comes from asking the API who the key belongs to, so only the password is prompted.
 */
export const withStepUp = async <T>(ctx: CliContext, api: WilsonSdk, call: (api: WilsonSdk) => Promise<T>, io: LoginIo = terminalIo): Promise<T> => {
    try {
        return await call(api);
    } catch (err) {
        if (!isStepUpRefusal(err)) throw err;
    }

    const email = await apiClient(ctx)
        .auth.getCurrentSession()
        .then(session => session.email)
        .catch(() => io.ask('Email'));
    const password = await io.askSecret(`Password for ${email ?? 'your account'} (this change needs it)`);
    if (!email || !password) throw new SignInError('a password is needed for this change');

    const accessToken = await signInWithPassword(ctx, email, password, io);
    const session = sessionClient(ctx, accessToken);
    try {
        return await call(session);
    } finally {
        await session.auth.logout().catch(() => undefined);
    }
};
