import type { CliContext } from '@maroonedsoftware/johnny5';
import { SdkError, WilsonSdk } from '@wilson/sdk';
import { keyStoreFor, resolveToken, type KeyStore } from './credentials.js';
import { apiSettings } from './settings.js';

/**
 * Where the API lives — `API_URL`/`PORT`, read via `apiSettings`. See `settings.ts` for the
 * fallbacks and why this doesn't read `ctx.config`.
 */
export const resolveApiBase = (ctx: CliContext): string => apiSettings(ctx).baseUrl;

/**
 * Card 0150. Which project this invocation targets — `WILSON_PROJECT`, read via `apiSettings` the
 * same way `resolveApiBase` reads `API_URL`/`PORT`, so it needs no per-command flag: every one of
 * the 16 commands already builds its client through `apiClient`/`withApi` below, so setting this
 * once here reaches all of them. Unset (the common case — a single-project deployment, or an
 * operator who hasn't opted into naming one) resolves to `undefined`, which `apiClient` below treats
 * as "send no project header at all" — the server then answers for its own configured project,
 * exactly what every command typed today already gets.
 */
export const resolveProject = (ctx: CliContext): string | undefined => apiSettings(ctx).project;

/**
 * One SDK instance per invocation, pointed at wherever config says the API lives, and signed with
 * this machine's API key when there is one (`WILSON_API_KEY`, else the keyring; see
 * `credentials.ts`). The key is read once, on the first request, not when the client is built: a
 * command that never calls the API never touches the keyring. With no key the request goes
 * unsigned, and an API that requires one answers 401, which `describeApiError` turns into
 * "run `wilson auth login`".
 */
export const apiClient = (ctx: CliContext, store: KeyStore = keyStoreFor(ctx, apiSettings(ctx).baseUrl)): WilsonSdk => {
    const { baseUrl, project } = apiSettings(ctx);
    let token: Promise<string | undefined> | undefined;
    return new WilsonSdk({
        baseUrl,
        headers: async () => {
            token ??= resolveToken(ctx, store);
            const bearer = await token;
            return {
                ...(project ? { 'X-Wilson-Project': project } : {}),
                ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            };
        },
    });
};

/** True for a `fetch` failure that never reached a server — a refused or absent connection. */
const isConnectionFailure = (err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    const cause = (err as { cause?: unknown }).cause;
    const code = (cause as { code?: string } | undefined)?.code ?? (err as { code?: string }).code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET') return true;
    return /fetch failed/i.test(err.message);
};

/**
 * Turn a failed API call into the message an operator should read.
 *
 * A refused connection is the new common failure for every command that talks to the API, so it
 * gets one message here rather than a stack trace repeated per command: "the API is not running,
 * here is how to start it." An `SdkError` reads its `reason` out of `details` — the board write
 * surface pins `message` to the generic HTTP status text and carries the actual explanation in
 * `details.reason` (`@maroonedsoftware/errors`' `httpError(...).withDetails(...)`) — so "0072 is not
 * flagged for a human" prints as that sentence, not "Request failed with status 400".
 */
export const describeApiError = (err: unknown, ctx: CliContext): string => {
    if (err instanceof SdkError && err.status === 401) {
        return `not signed in to the API at ${resolveApiBase(ctx)}: run \`wilson auth login\`, or set WILSON_API_KEY`;
    }
    if (err instanceof SdkError) {
        const body = err.body as { details?: { reason?: string }; message?: string } | undefined;
        return body?.details?.reason ?? body?.message ?? err.message;
    }
    if (isConnectionFailure(err)) {
        return `could not reach the API at ${resolveApiBase(ctx)} — is it running? start it with \`pnpm --filter @wilson/api start\` (or \`pnpm dev\` while iterating)`;
    }
    return err instanceof Error ? err.message : String(err);
};

/**
 * Wrap a command handler so every one gets the same failure handling for free: an API error prints
 * the operator-facing reason (not "Request failed with status 400"), a refused connection prints
 * one clear message instead of a stack trace, and either way the command exits 1. Handled once here
 * rather than duplicated in every command that talks to the API — the counterpart to
 * `requireContainer` for commands that no longer build a container at all.
 */
export const withApi = <Opts>(
    handler: (opts: Opts, ctx: CliContext, args: string[], api: WilsonSdk) => Promise<number | void>,
): ((opts: Opts, ctx: CliContext, args: string[]) => Promise<number | void>) => {
    return async (opts, ctx, args) => {
        const api = apiClient(ctx);
        try {
            return await handler(opts, ctx, args, api);
        } catch (err) {
            ctx.logger.error(describeApiError(err, ctx));
            return 1;
        }
    };
};
