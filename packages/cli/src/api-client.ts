import type { CliContext } from '@maroonedsoftware/johnny5';
import { SdkError, WilsonSdk } from '@wilson/sdk';

/** The port `apps/api` binds by default (apps/api/.env.example) — read from the same `PORT` config
 * key the server itself uses, so a CLI and a co-located API agree without a second variable. */
const DEFAULT_PORT = '13100';

/**
 * Where the API lives.
 *
 * `API_URL` overrides outright, for an operator running the API somewhere other than this machine.
 * Otherwise `localhost` on `PORT` — the same config key `apps/api` binds to (loaded from the same
 * `apps/api/.env` the CLI already reads), so the common case of "API and CLI on one box" needs no
 * configuration at all.
 */
export const resolveApiBase = (ctx: CliContext): string => {
    const override = ctx.config.get('API_URL', '').trim();
    if (override) return override.replace(/\/$/, '');
    return `http://localhost:${ctx.config.get('PORT', DEFAULT_PORT)}`;
};

/**
 * Card 0150. Which project this invocation targets — `WILSON_PROJECT`, read the same way
 * `resolveApiBase` reads `API_URL`/`PORT`, so it needs no per-command flag: every one of the 16
 * commands already builds its client through `apiClient`/`withApi` below, so setting this once here
 * reaches all of them. Unset (the common case — a single-project deployment, or an operator who
 * hasn't opted into naming one) resolves to `undefined`, which `apiClient` below treats as "send no
 * project header at all" — the server then answers for its own configured project, exactly what
 * every command typed today already gets.
 */
export const resolveProject = (ctx: CliContext): string | undefined => {
    const project = ctx.config.get('WILSON_PROJECT', '').trim();
    return project || undefined;
};

/** One SDK instance per invocation, pointed at wherever config says the API lives. */
export const apiClient = (ctx: CliContext): WilsonSdk => {
    const project = resolveProject(ctx);
    return new WilsonSdk({ baseUrl: resolveApiBase(ctx), headers: project ? { 'X-Wilson-Project': project } : undefined });
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
