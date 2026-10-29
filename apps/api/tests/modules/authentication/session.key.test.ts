import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { resolveEncryptionKey } from '#modules/authentication/encryption.key.js';
import { readSessionKey, resolveSessionKey } from '#modules/authentication/session.key.js';

const pem = (): string =>
    generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;

/** An `AppConfig` that answers from `values` and nothing else. */
const configOf = (values: Record<string, string>): AppConfig =>
    ({ get: (key: string, fallback?: unknown) => values[key] ?? fallback }) as unknown as AppConfig;

const scratch = () => mkdtemp(join(tmpdir(), 'wilson-session-key-'));

describe('readSessionKey', () => {
    it('returns a PEM unchanged', () => {
        const key = pem();

        expect(readSessionKey(key)).toBe(key.trim());
    });

    it('turns the two characters a .env writes for a line break back into one', () => {
        const key = pem().trim();

        expect(readSessionKey(key.replace(/\n/g, '\\n'))).toBe(key);
    });

    it('decodes a base64 PEM', () => {
        const key = pem().trim();

        expect(readSessionKey(Buffer.from(key).toString('base64'))).toBe(key);
    });

    it('hands back a value that is neither, to fail where it would have anyway', () => {
        expect(readSessionKey('not-a-key')).toBe('not-a-key');
    });

    it('reads an empty value as empty', () => {
        expect(readSessionKey('   ')).toBe('');
    });
});

describe('resolveSessionKey', () => {
    it('prefers AUTH_SESSION_PRIVATE_KEY and touches no file', async () => {
        const key = pem();
        const file = join(await scratch(), 'session.pem');

        const resolved = await resolveSessionKey(configOf({ AUTH_SESSION_PRIVATE_KEY: key, AUTH_SESSION_KEY_FILE: file }));

        expect(resolved).toBe(key.trim());
        await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('reads an existing key file', async () => {
        const key = pem();
        const file = join(await scratch(), 'session.pem');
        await writeFile(file, key, 'utf8');

        expect(await resolveSessionKey(configOf({ AUTH_SESSION_KEY_FILE: file }))).toBe(key.trim());
    });

    it('generates an owner-only key file when there is none, creating its directory', async () => {
        const file = join(await scratch(), 'nested', 'session.pem');

        const resolved = await resolveSessionKey(configOf({ AUTH_SESSION_KEY_FILE: file }));

        expect(resolved).toContain('-----BEGIN PRIVATE KEY-----');
        expect((await readFile(file, 'utf8')).trim()).toBe(resolved);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    });

    it('returns the same key on every boot after the first', async () => {
        const file = join(await scratch(), 'session.pem');
        const config = configOf({ AUTH_SESSION_KEY_FILE: file });

        const first = await resolveSessionKey(config);

        expect(await resolveSessionKey(config)).toBe(first.trim());
    });

    /** The daemon and a CLI command booting together must not each sign with a different key. */
    it('settles two concurrent first boots on one key', async () => {
        const file = join(await scratch(), 'session.pem');
        const config = configOf({ AUTH_SESSION_KEY_FILE: file });

        const [a, b] = await Promise.all([resolveSessionKey(config), resolveSessionKey(config)]);
        const onDisk = (await readFile(file, 'utf8')).trim();

        expect(a.trim()).toBe(onDisk);
        expect(b.trim()).toBe(onDisk);
    });
});

describe('resolveEncryptionKey', () => {
    it('reads a 64-hex-character AUTH_ENCRYPTION_KEY', async () => {
        const hex = 'ab'.repeat(32);

        expect((await resolveEncryptionKey(configOf({ AUTH_ENCRYPTION_KEY: hex }))).toString('hex')).toBe(hex);
    });

    it('refuses a key that is not 256 bits of hex, naming the variable', async () => {
        await expect(resolveEncryptionKey(configOf({ AUTH_ENCRYPTION_KEY: 'too-short' }))).rejects.toThrow(/AUTH_ENCRYPTION_KEY/);
    });

    it('generates a 256-bit key file on first use, owner-only, and reads the same key after', async () => {
        const file = join(await scratch(), 'encryption.key');
        const config = configOf({ AUTH_ENCRYPTION_KEY_FILE: file });

        const first = await resolveEncryptionKey(config);

        expect(first).toHaveLength(32);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await resolveEncryptionKey(config)).equals(first)).toBe(true);
    });
});
