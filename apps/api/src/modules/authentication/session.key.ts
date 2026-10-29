import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { optionalConfigString } from '#shared/require.config.js';

/**
 * Where the generated signing key lives when `AUTH_SESSION_PRIVATE_KEY` is unset: a sibling of the
 * code repo, outside it, the way `WILSON_BACKUP_DIR` defaults to `../.wilson-backups`. Outside the
 * repo so it can never be committed, and outside `PROJECT_RUN_ROOT` because plans are materialized
 * there for agents to read.
 */
const DEFAULT_KEY_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../.wilson-secrets/session.pem');

/**
 * The session signing key, however the deployment was able to spell it. deadair's reader: a PEM as
 * `openssl` writes it, the same PEM with its line breaks written as `\n` (what a `.env` carries),
 * or the PEM base64'd to get it through a field that mangles everything else.
 *
 * Nothing here validates the key. It only undoes what a text field does to one, and anything that
 * is not a key comes back unchanged, to fail where it would have failed anyway.
 */
export function readSessionKey(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return trimmed;

    if (trimmed.includes('-----BEGIN')) {
        return trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
    }

    // Decoded only when the result is recognisably a key, so a corrupted value is not silently
    // replaced by whatever bytes it happens to decode to.
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    return decoded.includes('-----BEGIN') ? decoded.trim() : trimmed;
}

/**
 * The PEM every session token is signed with.
 *
 * `AUTH_SESSION_PRIVATE_KEY` wins when set. Otherwise the key is read from `AUTH_SESSION_KEY_FILE`
 * (default {@link DEFAULT_KEY_FILE}), and generated there on first use if the file does not exist,
 * as deadair's container generates its keys on first boot. Failing to boot without a key would be
 * the stricter choice, but the CLI builds this same container, so an unset key would stop every
 * `wilson` command and the daemon's next restart until someone edited `.env`.
 *
 * The file is written owner-only. That keeps it from other users on the host, not from a stage:
 * project code a stage runs is this same user, and can read this file exactly as it can read
 * `apps/api/.env` (PROJECT.md, Authentication).
 */
export async function resolveSessionKey(config: AppConfig): Promise<string> {
    const configured = readSessionKey(optionalConfigString(config, 'AUTH_SESSION_PRIVATE_KEY') ?? '');
    if (configured.length > 0) return configured;

    const file = optionalConfigString(config, 'AUTH_SESSION_KEY_FILE') ?? DEFAULT_KEY_FILE;
    const existing = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
    });
    if (existing !== undefined) return readSessionKey(existing);

    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // `wx`: if two processes generate at once (the daemon and a CLI command booting together), the
    // second write fails rather than replacing a key the first may already have signed with.
    try {
        await writeFile(file, privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        return readSessionKey(await readFile(file, 'utf8'));
    }
    await chmod(file, 0o600);
    return privateKey;
}
