import { describe, expect, it } from 'vitest';
import { apiSettings, databaseSettings, setting } from '#src/settings.js';

/**
 * Card 0247. Before this card, every one of these readers went through `ctx.config`, which
 * `createCliApp` (index.ts) never gets a source for — `ctx.config.get(key, fallback)` returned
 * `fallback` for every key, always, regardless of what `apps/api/.env` set. These readers go
 * through `ctx.env` instead, which johnny5's `buildContext` populates after loading `.env` and
 * `apps/api/.env`. Every `ctx` built below carries only `env` — no `config` at all — so a reader
 * that still reached for `ctx.config` would throw here, not silently fall back.
 */
describe('setting', () => {
    it('returns the trimmed value from ctx.env when present', () => {
        const ctx = { env: { FOO: '  bar  ' } } as never;

        expect(setting(ctx, 'FOO', 'fallback')).toBe('bar');
    });

    it('returns the fallback when the key is absent from ctx.env', () => {
        const ctx = { env: {} } as never;

        expect(setting(ctx, 'FOO', 'fallback')).toBe('fallback');
    });

    it('returns the fallback when the value is present but blank', () => {
        const ctx = { env: { FOO: '   ' } } as never;

        expect(setting(ctx, 'FOO', 'fallback')).toBe('fallback');
    });
});

describe('databaseSettings', () => {
    it('reads all five DATABASE_* values from ctx.env, with none missing (AC1)', () => {
        const ctx = {
            env: {
                DATABASE_HOST: 'db.internal',
                DATABASE_PORT: '5433',
                DATABASE_USER: 'wilson',
                DATABASE_PASSWORD: 'secret',
                DATABASE_NAME: 'wilson_db',
            },
        } as never;

        const result = databaseSettings(ctx);

        expect(result).toEqual({
            host: 'db.internal',
            port: '5433',
            user: 'wilson',
            password: 'secret',
            database: 'wilson_db',
            missing: [],
        });
    });

    it('falls back DATABASE_PORT to 5432 but still names it missing (today’s "genuinely unset" behaviour, AC6)', () => {
        const ctx = {
            env: {
                DATABASE_HOST: 'db.internal',
                DATABASE_USER: 'wilson',
                DATABASE_PASSWORD: 'secret',
                DATABASE_NAME: 'wilson_db',
            },
        } as never;

        const result = databaseSettings(ctx);

        expect(result.port).toBe('5432');
        expect(result.missing).toEqual(['DATABASE_PORT']);
    });

    it('names every unset or blank key when nothing is configured', () => {
        const ctx = { env: {} } as never;

        const result = databaseSettings(ctx);

        expect(result.missing).toEqual(['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME']);
    });
});

describe('apiSettings', () => {
    it('uses API_URL outright, stripping a trailing slash, when set (AC4)', () => {
        const ctx = { env: { API_URL: 'https://wilson.example.com/' } } as never;

        expect(apiSettings(ctx).baseUrl).toBe('https://wilson.example.com');
    });

    it('falls back to localhost:PORT when only PORT is set (AC4)', () => {
        const ctx = { env: { PORT: '9999' } } as never;

        expect(apiSettings(ctx).baseUrl).toBe('http://localhost:9999');
    });

    it('falls back to localhost:13100 when neither API_URL nor PORT is set (AC4, AC6)', () => {
        const ctx = { env: {} } as never;

        expect(apiSettings(ctx).baseUrl).toBe('http://localhost:13100');
    });

    it('reads WILSON_PROJECT when set (AC5)', () => {
        const ctx = { env: { WILSON_PROJECT: 'acme' } } as never;

        expect(apiSettings(ctx).project).toBe('acme');
    });

    it('resolves project to undefined when WILSON_PROJECT is unset, same as today (AC5, AC6)', () => {
        const ctx = { env: {} } as never;

        expect(apiSettings(ctx).project).toBeUndefined();
    });
});
