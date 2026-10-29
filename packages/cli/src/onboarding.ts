import type { CliContext } from '@maroonedsoftware/johnny5';
import { SdkError, WilsonSdk } from '@wilson/sdk';
import { describeApiError, resolveApiBase, resolveProject } from './api-client.js';
import type { KeyStore } from './credentials.js';
import { signInThisMachine, SignInError, terminalIo, type LoginIo, type MachineKey } from './sign.in.js';

/** How the operator answers: prompted, or (for a script) the email address as a flag and the password on stdin. */
export interface CredentialOpts {
    email?: string;
    passwordStdin?: boolean;
}

/**
 * Why the API refused the account. The password policy's refusal carries zxcvbn's warning and
 * suggestions in `details.password` and `details.suggestions`, not the `details.reason` other
 * refusals use (the web app's `onboardingFailure` reads it the same way).
 */
const passwordAdvice = (err: unknown): string | undefined => {
    if (!(err instanceof SdkError) || err.status !== 400) return undefined;
    const details = (err.body as { details?: { password?: string; suggestions?: string[] } } | undefined)?.details;
    if (details?.password === undefined && !details?.suggestions) return undefined;
    const advice = [details.password, ...(details.suggestions ?? [])].filter(Boolean).join(' ');
    return `that password is too easy to guess.${advice ? ` ${advice}` : ''}`;
};

const refusal = (err: unknown, ctx: CliContext): string => {
    if (err instanceof SdkError && err.status === 409) return 'an account already exists; sign in with `wilson auth login` instead';
    return passwordAdvice(err) ?? describeApiError(err, ctx);
};

/** One `@`, with something either side of it and no whitespace: the API checks it properly. */
const LOOKS_LIKE_EMAIL = /^[^@\s]+@[^@\s]+$/;

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
): Promise<{ email: string; key: MachineKey }> => {
    const project = resolveProject(ctx);
    const anonymous = new WilsonSdk({ baseUrl: resolveApiBase(ctx), headers: project ? { 'X-Wilson-Project': project } : {} });

    ctx.logger.info('No account exists yet. Create the operator account; it is the only one, so keep the password somewhere safe.');
    const email = (opts.email ?? (await io.ask('Email')))?.trim();
    if (!email) throw new SignInError('an email address is needed to create the account');
    if (!LOOKS_LIKE_EMAIL.test(email)) throw new SignInError(`${email} is not an email address`);

    for (;;) {
        const password = await choosePassword(ctx, opts, io);
        if (!password) throw new SignInError('a password is needed to create the account');
        try {
            await anonymous.onboarding.createAccount({ email, password });
        } catch (err) {
            // Only a weak password is worth asking again for, and only of someone at the terminal.
            const advice = passwordAdvice(err);
            if (!advice || opts.passwordStdin) throw new SignInError(refusal(err, ctx));
            ctx.logger.warn(advice);
            continue;
        }
        return { email, key: await signInThisMachine(ctx, email, password, keys, io) };
    }
};
