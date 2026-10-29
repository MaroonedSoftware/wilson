import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { optionalConfigString } from '#shared/require.config.js';
import { readOrCreateSecretFile, SECRETS_DIR } from './secret.file.js';

/** Where the generated key lives when `AUTH_ENCRYPTION_KEY` is unset (`secret.file.ts`). */
const DEFAULT_KEY_FILE = join(SECRETS_DIR, 'encryption.key');

const HEX_256 = /^[0-9a-fA-F]{64}$/;

/**
 * The 256-bit root key `@maroonedsoftware/encryption`'s `EncryptionProvider` encrypts stored
 * secrets with: today, each authenticator app's TOTP seed, which must be readable again to check a
 * code and so cannot be hashed the way a password is.
 *
 * `AUTH_ENCRYPTION_KEY` (64 hex characters) wins when set. Otherwise it is read from
 * `AUTH_ENCRYPTION_KEY_FILE`, default `../.wilson-secrets/encryption.key`, and generated there on
 * first boot, the same way and for the same reason as the session signing key (`session.key.ts`).
 * Losing it makes every enrolled authenticator unreadable, so back it up with the database.
 */
export async function resolveEncryptionKey(config: AppConfig): Promise<Buffer> {
    const configured = optionalConfigString(config, 'AUTH_ENCRYPTION_KEY');
    const hex = (
        configured ??
        (await readOrCreateSecretFile(optionalConfigString(config, 'AUTH_ENCRYPTION_KEY_FILE') ?? DEFAULT_KEY_FILE, () =>
            randomBytes(32).toString('hex'),
        ))
    ).trim();
    if (!HEX_256.test(hex)) {
        throw new Error(`${configured ? 'AUTH_ENCRYPTION_KEY' : 'The encryption key file'} must be 64 hex characters (a 256-bit key).`);
    }
    return Buffer.from(hex, 'hex');
}
