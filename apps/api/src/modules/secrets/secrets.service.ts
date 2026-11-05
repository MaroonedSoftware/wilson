import { Injectable } from 'injectkit';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { httpError } from '@maroonedsoftware/errors';
import type { PutSecretRequest, SecretSummary } from '../../generated/secrets.js';
import { SecretRepository } from './secret.repository.js';

/** A name an operator can type and a command line can carry unquoted. */
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** What stands in for a secret's value in anything shown after {@link SecretsService.redact}. */
export const REDACTED = '[redacted]';

/**
 * The secrets behind `/api/secrets` (`secrets.ck`), encrypted under the same root key as the engine
 * tokens.
 *
 * Nothing the API returns carries a value: {@link resolve} is the only way to read one back, and it is
 * never reached from a contract.
 */
@Injectable()
export class SecretsService {
    constructor(
        private readonly secrets: SecretRepository,
        private readonly encryption: EncryptionProvider,
    ) {}

    async list(): Promise<SecretSummary[]> {
        return this.secrets.list();
    }

    /** Encrypt and save `request.value` under `name`, replacing any saved there. Refuses a bad name or an empty value with 400. */
    async put(name: string, { value }: PutSecretRequest): Promise<SecretSummary> {
        if (!SECRET_NAME.test(name)) {
            throw httpError(400).withDetails({ reason: 'a secret name is lowercase letters, digits, dots, dashes and underscores' });
        }
        // A pipe or a paste brings a trailing newline, which would otherwise become part of the value.
        const trimmed = value.trim();
        if (trimmed.length === 0) throw httpError(400).withDetails({ reason: 'a secret cannot be empty' });
        return this.secrets.put(name, this.encryption.encrypt(trimmed));
    }

    /** Forget `name`. Never decrypts it, so this still works after the key is lost. Refuses an unknown name with 404. */
    async remove(name: string): Promise<void> {
        if (!(await this.secrets.remove(name))) {
            throw httpError(404).withDetails({ reason: `no secret is saved as "${name}"` });
        }
    }

    /**
     * The value saved as `name`, or undefined when none is. Refuses a row that will not decrypt, for
     * the reason `EngineTokensService.resolve` does.
     */
    async resolve(name: string): Promise<string | undefined> {
        const ciphertext = await this.secrets.ciphertext(name);
        if (ciphertext === undefined) return undefined;
        try {
            return this.encryption.decrypt(ciphertext);
        } catch {
            throw new Error(`The secret "${name}" cannot be decrypted, so the encryption key has changed. Save it again.`);
        }
    }

    /**
     * `text` with every saved secret's value replaced by {@link REDACTED}, for text that came from
     * outside Wilson and is about to be shown or stored. Matches the exact value only, so it stops an
     * accident and not a value that was encoded or split. A row that will not decrypt is skipped: it
     * has nothing left to redact with, and that must not make the text unreadable.
     */
    async redact(text: string): Promise<string> {
        let redacted = text;
        for (const ciphertext of await this.secrets.allCiphertext()) {
            let value: string;
            try {
                value = this.encryption.decrypt(ciphertext);
            } catch {
                continue;
            }
            redacted = redacted.replaceAll(value, REDACTED);
        }
        return redacted;
    }
}
