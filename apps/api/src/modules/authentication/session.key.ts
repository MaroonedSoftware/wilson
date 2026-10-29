import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { optionalConfigString } from '#shared/require.config.js';
import { readOrCreateSecretFile, SECRETS_DIR } from './secret.file.js';

/** Where the generated signing key lives when `AUTH_SESSION_PRIVATE_KEY` is unset (`secret.file.ts`). */
const DEFAULT_KEY_FILE = join(SECRETS_DIR, 'session.pem');

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
 * as deadair's container generates its keys on first boot (`readOrCreateSecretFile`). Failing to
 * boot without a key would be the stricter choice, but the CLI builds this same container, so an
 * unset key would stop every `wilson` command and the daemon's next restart until someone edited
 * `.env`.
 */
export async function resolveSessionKey(config: AppConfig): Promise<string> {
    const configured = readSessionKey(optionalConfigString(config, 'AUTH_SESSION_PRIVATE_KEY') ?? '');
    if (configured.length > 0) return configured;

    const file = optionalConfigString(config, 'AUTH_SESSION_KEY_FILE') ?? DEFAULT_KEY_FILE;
    const pem = await readOrCreateSecretFile(
        file,
        () =>
            generateKeyPairSync('rsa', {
                modulusLength: 2048,
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
                publicKeyEncoding: { type: 'spki', format: 'pem' },
            }).privateKey,
    );
    return readSessionKey(pem);
}
