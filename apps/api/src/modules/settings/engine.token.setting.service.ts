import { Injectable } from 'injectkit';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { httpError } from '@maroonedsoftware/errors';
import type { EngineTokenSetting, SetEngineTokenSettingRequest } from '#src/generated/settings.js';
import { SettingsStore } from './settings.store.js';
import { ENGINE_TOKEN } from './engine.token.setting.js';

/** `token` trimmed, refusing what `CLAUDE_CODE_OAUTH_TOKEN` could not carry with 400. */
export const requireEngineToken = (token: string): string => {
    const trimmed = token.trim();
    if (trimmed === '' || /\s/.test(trimmed)) {
        throw httpError(400).withDetails({ reason: 'the engine token must be a single word, as `claude setup-token` prints it' });
    }
    return trimmed;
};

/**
 * The engine token saved in `wilson.settings`, encrypted under the same root key as the TOTP seeds.
 *
 * Reaches engines on this machine only: `engineEnvironment` and `SshHost` both drop a token Wilson
 * sends, so a worker or SSH host goes on signing in as it was set up to.
 *
 * Callers resolve it once per engine start and pass it to `subscriptionEnv`, the same as
 * `claude-config-dir`, so a save reaches the next stage or session and never one already running.
 */
@Injectable()
export class EngineTokenSettingService {
    constructor(
        private readonly settings: SettingsStore,
        private readonly encryption: EncryptionProvider,
    ) {}

    /**
     * The saved token, or `undefined` when none is. Refuses a row that will not decrypt rather than
     * falling through: the engine would then report "Not logged in", which points nowhere near the
     * encryption key that is actually at fault.
     */
    async resolve(): Promise<string | undefined> {
        const ciphertext = await this.settings.stored(ENGINE_TOKEN);
        if (ciphertext === undefined) return undefined;
        try {
            return this.encryption.decrypt(ciphertext);
        } catch {
            throw new Error('The saved engine token cannot be decrypted, so the encryption key has changed. Save the token again.');
        }
    }

    /** Encrypt and persist `token`, refusing what `CLAUDE_CODE_OAUTH_TOKEN` could not carry. */
    async save(token: string): Promise<void> {
        await this.settings.set(ENGINE_TOKEN, this.encryption.encrypt(requireEngineToken(token)));
    }

    /** Remove the saved token. Never decrypts it, so this still works after the key is lost. */
    async clear(): Promise<void> {
        await this.settings.clear(ENGINE_TOKEN);
    }

    /** Which sign-in an engine started now would use, without touching the token itself. */
    async source(): Promise<EngineTokenSetting['source']> {
        if ((await this.settings.stored(ENGINE_TOKEN)) !== undefined) return 'database';
        return process.env[ENGINE_TOKEN.envVar] === undefined ? 'none' : 'environment';
    }

    /** The contract-facing read: where the sign-in comes from, never the token. */
    async get(): Promise<EngineTokenSetting> {
        return { source: await this.source() };
    }

    /** The contract-facing write: save a token, or remove the saved one on `null`. */
    async set(body: SetEngineTokenSettingRequest): Promise<EngineTokenSetting> {
        if (body.token === null) await this.clear();
        else await this.save(body.token);
        return this.get();
    }
}
