import { SdkError } from '@wilson/sdk';

/**
 * The server's own sentence for a refusal. Shared by the settings and hosts pages, which both show
 * a refused write in the server's own words. `errorMiddleware`'s body is `{ statusCode, message,
 * details }` (`@maroonedsoftware/koa`); a specific refusal (out-of-range interval, an unsafe
 * webhook destination) pins `message` to the generic HTTP status text and carries the actual
 * sentence in `details.reason` (`httpError(...).withDetails({ reason })` — same convention
 * `useMoveCard`/`useStartCard`'s `reasonFor` reads, `apps/web/src/lib/mutations.ts`), so this reads
 * `details.reason` first and only falls back to `message` where a route has no such detail. Falls
 * back further to the SDK's generic "<status> <statusText>" only when the body isn't that shape,
 * which happens for a network failure that never reached the server.
 */
export function apiErrorMessage(error: unknown): string {
    if (error instanceof SdkError && error.body && typeof error.body === 'object') {
        const body = error.body as { details?: { reason?: unknown }; message?: unknown };
        if (typeof body.details?.reason === 'string') return body.details.reason;
        if (typeof body.message === 'string') return body.message;
    }
    return error instanceof Error ? error.message : String(error);
}
