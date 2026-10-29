import type { CliContext } from '@maroonedsoftware/johnny5';
import { SdkError, WilsonSdk } from '@wilson/sdk';
import { describeApiError, resolveApiBase, resolveProject } from './api-client.js';
import type { KeyStore } from './credentials.js';
import { signInThisMachine, SignInError, terminalIo, type LoginIo, type MachineKey } from './sign.in.js';

/** How the operator answers: prompted, or (for a script) the username as a flag and the password on stdin. */
export interface CredentialOpts {
    username?: string;
    passwordStdin?: boolean;
}

/**
 * Why the API refused the account. The password policy's refusal carries zxcvbn's warning and
 * suggestions in `details.password` and `details.suggestions`, not the `details.reason` other
 * refusals use (the web app's `onboardingFailure` reads it the same way).
 */
const refusal = (err: unknown, ctx: CliContext): string => {
    if (err instanceof SdkError && err.status === 409) return 'an account already exists; sign in with `wilson auth login` instead';
    if (err instanceof SdkError) {
        const details = (err.body as { details?: { password?: string; suggestions?: string[] } } | undefined)?.details;
        if (details?.password !== undefined || details?.suggestions) {
            const advice = [details.password, ...(details.suggestions ?? [])].filter(Boolean).join(' ');
            return `that password is too easy to guess.${advice ? ` ${advice}` : ''}`;
        }
    }
    return describeApiError(err, ctx);
};

const isTooWeak = (err: unknown): boolean => err instanceof SdkError && err.status === 400;

/**
 * The password for a new account: from stdin when asked to, otherwise prompted twice, since there is
 * no "forgot password" to recover a typo with. `undefined` when the operator gives up.
 */
const choosePassword = async (ctx: CliContext, opts: CredentialOpts, io: LoginIo): Promise<string | undefined> => {
    if (opts.passwordStdin) return (await io.readStdin()).replace(/\r?\n$/, '') || undefined;
    for (;;) {
        const password = await io.askSecret('Choose a password');
        if (!password) return undefined;
        const again = await io.askSecret('Type it again');
        if (again === undefined) return undefined;
        if (again === password) return password;
        ctx.logger.warn('those did not match; try again');
    }
};

/**
 * First-run onboarding from the terminal: create the operator account (`POST /api/onboarding`, the
 * same call the web app's onboarding form makes) and sign this machine in with it, so the command
 * that needed an account can carry on. A password the policy refuses is explained and asked for
 * again, unless it came from stdin, where nobody is there to answer.
 *
 * Throws `SignInError` with the operator-facing reason.
 */
export const createOperatorAccount = async (
    ctx: CliContext,
    opts: CredentialOpts,
    keys: KeyStore,
    io: LoginIo = terminalIo,
): Promise<{ username: string; key: MachineKey }> => {
    const project = resolveProject(ctx);
    const anonymous = new WilsonSdk({ baseUrl: resolveApiBase(ctx), headers: project ? { 'X-Wilson-Project': project } : {} });

    ctx.logger.info('No account exists yet. Create the operator account; it is the only one, so keep the password somewhere safe.');
    const username = (opts.username ?? (await io.ask('Username')))?.trim();
    if (!username) throw new SignInError('a username is needed to create the account');

    for (;;) {
        const password = await choosePassword(ctx, opts, io);
        if (!password) throw new SignInError('a password is needed to create the account');
        try {
            await anonymous.onboarding.createAccount({ username, password });
        } catch (err) {
            if (!isTooWeak(err) || opts.passwordStdin) throw new SignInError(refusal(err, ctx));
            ctx.logger.warn(refusal(err, ctx));
            continue;
        }
        return { username, key: await signInThisMachine(ctx, username, password, keys, io) };
    }
};
