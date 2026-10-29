import type { CliContext, CommandModule } from '@maroonedsoftware/johnny5';
import { SdkError, type BoardColumns } from '@wilson/sdk';
import { apiClient, describeApiError, resolveApiBase } from '../../api-client.js';
import { keyStoreFor, type KeyStore } from '../../credentials.js';
import { createOperatorAccount, type CredentialOpts } from '../../onboarding.js';
import { setting } from '../../settings.js';
import { SignInError, terminalIo, type LoginIo } from '../../sign.in.js';
import { login } from '../auth/login.command.js';

/**
 * Sign this machine in when it is not, so init can run on a fresh install: with no account yet,
 * create the operator account (`createOperatorAccount`); with one, sign in as it (`wilson auth
 * login`). Throws `SignInError` when that did not work.
 *
 * False when `WILSON_API_KEY` is set: that key is what every request sends, so a key stored in the
 * keyring would not be used, and the 401 is about the variable.
 */
const signInForInit = async (ctx: CliContext, opts: CredentialOpts, keys: KeyStore, io: LoginIo): Promise<boolean> => {
    if (setting(ctx, 'WILSON_API_KEY', '')) return false;

    const { requirements } = await apiClient(ctx, keys).onboarding.getOnboardingStatus();
    // The terminal can meet the account requirement and nothing else, so it names any other.
    for (const requirement of requirements.filter(each => each.key !== 'account' && !each.optional)) {
        ctx.logger.warn(`first run also needs: ${requirement.title}. Finish it in the web app.`);
    }
    if (!requirements.some(requirement => requirement.key === 'account')) {
        ctx.logger.info('Sign in to initialise the board.');
        // `login` has already said why it failed.
        if ((await login(opts, ctx, io, keys)) !== 0) throw new SignInError('not signed in, so the board was not initialised');
        return true;
    }
    const { email, key } = await createOperatorAccount(ctx, opts, keys, io);
    ctx.logger.info(`created the account ${email} and signed this machine in; its key is "${key.name}" (…${key.hint})`);
    return true;
};

const isUnauthorised = (err: unknown): boolean => err instanceof SdkError && err.status === 401;

/**
 * Give the project its first stage config.
 *
 * This used to scaffold the sibling board repo — `cards/`, `config/`, `context/`, a `stages.yaml`,
 * and the git repo itself. The board is Postgres now, stage config included, so all that is left
 * to initialise is the `runner.stage_configs` row holding a default document an operator can start
 * a card against immediately (`BoardBootstrapService.init`, behind `POST /api/board/init`). It is
 * keyed by the project the request is for (`WILSON_PROJECT`, or the daemon's own), and refuses a
 * project that already has one — `wilson stages edit` is how a config changes from here.
 *
 * It is also the first command run on a fresh install, before any account exists to sign in with.
 * So a 401 is not the end of it: init creates the operator account, or signs in to the one there is,
 * and tries again. A machine already signed in makes the one call it always did.
 */
export const init = async (opts: CredentialOpts, ctx: CliContext, io: LoginIo = terminalIo, store?: KeyStore): Promise<number> => {
    const keys = store ?? keyStoreFor(ctx, resolveApiBase(ctx));
    let columns: BoardColumns;
    try {
        try {
            columns = await apiClient(ctx, keys).board.initialiseBoard();
        } catch (err) {
            if (!isUnauthorised(err) || !(await signInForInit(ctx, opts, keys, io))) throw err;
            // A new client, since a client reads the key once, and this one read none.
            columns = await apiClient(ctx, keys).board.initialiseBoard();
        }
    } catch (err) {
        ctx.logger.error(err instanceof SignInError ? err.message : describeApiError(err, ctx));
        return 1;
    }

    ctx.logger.info(`board initialised — stages: ${columns.stages.join(', ') || '(none configured)'}`);
    ctx.logger.info('Write a card with `wilson card create <title>`, approve its plan, then `wilson card start <id>`.');
    return 0;
};

const command: CommandModule<CredentialOpts> = {
    description: 'Give the project its first stage config, creating the operator account first on a fresh install',
    options: [
        { flags: '--email <address>', description: 'The account email address, if init has to sign in (prompted for if omitted)', type: 'string' },
        { flags: '--password-stdin', description: 'Read the password from stdin instead of prompting', type: 'boolean' },
    ],
    run: (opts, ctx) => init(opts, ctx),
};

export default command;
