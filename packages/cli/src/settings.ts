import type { CliContext } from '@maroonedsoftware/johnny5';

/**
 * Every reader in this file goes through `ctx.env`, not `ctx.config`.
 *
 * `createCliApp` (index.ts) passes no `config`, so `ctx.config` is johnny5's bare default —
 * `new AppConfigBuilder().addResolver(new AppConfigResolverEnv()).buildSnapshot()`, a resolver with
 * no source — and `ctx.config.get(key)` returns the fallback for every key, always. Passing a
 * `config` wouldn't fix it either: johnny5 builds that config before it loads the env files, so it
 * would miss whatever `.env`/`apps/api/.env` set. `ctx.env` is populated after those files load, so
 * every setting the CLI needs — `DATABASE_*`, `PROJECT_CODE_ROOT`, the provider keys, `API_URL`,
 * `PORT`, `WILSON_PROJECT` — is read from there instead.
 */
export const setting = (ctx: CliContext, key: string, fallback: string): string => {
    const value = ctx.env[key]?.trim();
    return value ? value : fallback;
};

const DATABASE_KEYS = ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME'] as const;

export interface DatabaseSettings {
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
    /** The `DATABASE_*` keys that were unset or blank. */
    missing: string[];
}

/**
 * The five `DATABASE_*` values pg and pg-boss connect with — read once here instead of five separate
 * `setting` calls per caller (11 today, across the postgres-reachable and queue-reachable checks).
 * `port` falls back to `5432`; `missing` names every key that was unset or blank, regardless of that
 * fallback, so a caller that wants "is this actually configured" still gets a real answer.
 */
export const databaseSettings = (ctx: CliContext): DatabaseSettings => {
    const missing = DATABASE_KEYS.filter(key => !ctx.env[key]?.trim());
    return {
        host: setting(ctx, 'DATABASE_HOST', ''),
        port: setting(ctx, 'DATABASE_PORT', '5432'),
        user: setting(ctx, 'DATABASE_USER', ''),
        password: setting(ctx, 'DATABASE_PASSWORD', ''),
        database: setting(ctx, 'DATABASE_NAME', ''),
        missing: [...missing],
    };
};

export interface ApiSettings {
    baseUrl: string;
    project: string | undefined;
}

/**
 * Where the API lives and which project to target — `API_URL`/`PORT` and `WILSON_PROJECT`, folded
 * into the one reader `api-client.ts` uses.
 *
 * `API_URL` overrides outright, for an operator running the API somewhere other than this machine.
 * Otherwise `localhost` on `PORT` — the same config key `apps/api` binds to (loaded from the same
 * `apps/api/.env` the CLI already reads), so the common case of "API and CLI on one box" needs no
 * configuration at all. `project` unset (the common case — a single-project deployment) resolves to
 * `undefined`, which callers treat as "send no project header at all".
 */
export const apiSettings = (ctx: CliContext): ApiSettings => {
    const override = setting(ctx, 'API_URL', '');
    const baseUrl = override ? override.replace(/\/$/, '') : `http://localhost:${setting(ctx, 'PORT', '13100')}`;
    const project = setting(ctx, 'WILSON_PROJECT', '');
    return { baseUrl, project: project || undefined };
};
