import { isCancel, password as promptPassword, text as promptText } from '@clack/prompts';
import type { CliContext } from '@maroonedsoftware/johnny5';
import { SdkError, WilsonSdk } from '@wilson/sdk';
import { apiClient, describeApiError, resolveApiBase } from './api-client.js';
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
 * Sign in with a username and password, returning the new session's access token. Unsigned, since
 * this is how a credential is obtained. With an authenticator app enrolled, the password answers
 * `mfa_required`, and this asks for the app's code and completes the sign-in with it. Throws
 * `SignInError` with the operator-facing reason.
 */
export const signInWithPassword = async (ctx: CliContext, username: string, password: string, io: LoginIo = terminalIo): Promise<string> => {
    const anonymous = new WilsonSdk({ baseUrl: resolveApiBase(ctx), headers: projectHeaders(ctx) });
    const refused = (err: unknown, wrong: string): SignInError => {
        if (err instanceof SdkError && err.status === 401) return new SignInError(wrong);
        if (err instanceof SdkError && err.status === 429) return new SignInError('too many wrong attempts; wait five minutes and try again');
        return new SignInError(describeApiError(err, ctx));
    };

    let first;
    try {
        first = await anonymous.auth.requestToken({ grant_type: 'password', username, password });
    } catch (err) {
        throw refused(err, 'wrong username or password');
    }
    if (first.result === 'token' && first.accessToken) return first.accessToken;

    const [factor] = first.factors ?? [];
    const code = await io.askSecret(`Code from your authenticator app${factor?.label ? ` (${factor.label})` : ''}`);
    if (!code || !first.challengeId) throw new SignInError('a code from your authenticator app is needed to sign in');
    try {
        const second = await anonymous.auth.requestToken({
            grant_type: 'authenticator',
            challenge_id: first.challengeId,
            factor_id: factor?.id,
            code,
        });
        if (!second.accessToken) throw new SignInError('the API did not return a session');
        return second.accessToken;
    } catch (err) {
        if (err instanceof SignInError) throw err;
        throw refused(err, 'wrong code');
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
 * straight after. That is how `wilson stages edit|set` save: an API key never satisfies
 * `wilson.step.up` (PROJECT.md, Authentication: Factors), so a leaked key cannot rewrite stage
 * config, and the operator types the password at the moment it matters instead of on every command.
 *
 * The username comes from asking the API who the key belongs to, so only the password is prompted.
 */
export const withStepUp = async <T>(ctx: CliContext, api: WilsonSdk, call: (api: WilsonSdk) => Promise<T>, io: LoginIo = terminalIo): Promise<T> => {
    try {
        return await call(api);
    } catch (err) {
        if (!isStepUpRefusal(err)) throw err;
    }

    const username = await apiClient(ctx)
        .auth.getCurrentSession()
        .then(session => session.username)
        .catch(() => io.ask('Username'));
    const password = await io.askSecret(`Password for ${username ?? 'your account'} (this change needs it)`);
    if (!username || !password) throw new SignInError('a password is needed for this change');

    const accessToken = await signInWithPassword(ctx, username, password, io);
    const session = sessionClient(ctx, accessToken);
    try {
        return await call(session);
    } finally {
        await session.auth.logout().catch(() => undefined);
    }
};
