import { AppConfig } from '@maroonedsoftware/appconfig';

/**
 * The single home for reading config values.
 *
 * `AppConfig.get` returns the raw value with no coercion and no defaults, and every source we use
 * (dotenv, env resolver) hands back strings. These helpers do the conversion once, in one place, so
 * a missing key fails loudly at the point it's needed rather than slipping through as a
 * plausible-but-wrong value.
 */

/**
 * Read an optional config value, normalising "not configured" to `undefined`.
 *
 * An empty string and the literal `"null"` both count as absent: a key present-but-blank in `.env`
 * means the operator has not configured it, not that the value is the empty string.
 */
export function optionalConfigString(config: AppConfig, key: string): string | undefined {
    const value = config.get(key, '');
    if (value === '' || value === 'null') {
        return undefined;
    }
    return value;
}

/**
 * Read a required config value, failing fast with a clear, named error when it is absent.
 */
export function requireConfigString(config: AppConfig, key: string): string {
    const value = optionalConfigString(config, key);
    if (!value) {
        throw new Error(`Missing required configuration: ${key}. Set it in apps/api/.env.`);
    }
    return value;
}

/**
 * Read a numeric config value, falling back when the key is absent or does not parse.
 *
 * Without a fallback an unparseable value throws, so a typo'd port or timeout is caught at boot
 * instead of silently becoming `NaN`.
 */
export function configNumber(config: AppConfig, key: string, fallback?: number): number {
    const raw = optionalConfigString(config, key);
    const parsed = raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(parsed)) {
        return parsed;
    }
    if (fallback !== undefined) {
        return fallback;
    }
    throw new Error(`Invalid configuration: ${key} must be a number (got ${raw ?? 'nothing'}). Set it in apps/api/.env.`);
}

/**
 * Read a boolean config value. Only `true` and `1` enable a flag; anything else (including an
 * absent key) leaves it at `fallback`, so `KEY=false` in `.env` means what it says.
 */
export function configBoolean(config: AppConfig, key: string, fallback = false): boolean {
    const raw = optionalConfigString(config, key);
    if (raw === undefined) {
        return fallback;
    }
    const normalized = raw.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
}
