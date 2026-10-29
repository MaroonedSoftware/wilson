/**
 * Where the API lives.
 *
 * Kept free of `import.meta` so it can be unit tested without a Vite environment — `sdk.ts` is
 * where the environment is read and handed to `resolveApiBase`.
 */

/** The port `apps/api` serves on by default (apps/api/.env.example). */
export const DEFAULT_API_BASE = 'http://localhost:13100';

/**
 * There is no same-origin proxy: the browser talks to the API directly, which admits this app's
 * origin (`WEB_ORIGINS` in apps/api) with credentials, so its session cookies travel cross-port.
 * `VITE_API_URL` overrides for a non-local deployment.
 */
export const resolveApiBase = (configured: string | undefined): string => {
    const trimmed = configured?.trim();
    return trimmed ? trimmed.replace(/\/$/, '') : DEFAULT_API_BASE;
};
