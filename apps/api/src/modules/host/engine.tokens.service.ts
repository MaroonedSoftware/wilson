import { Injectable } from 'injectkit';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { httpError } from '@maroonedsoftware/errors';
import { requireEngineToken } from '#modules/settings/engine.token.setting.service.js';
import type { EngineTokenSummary, PutEngineTokenRequest } from '../../generated/engine.tokens.js';
import type { Host, PutHostEngineTokenRequest } from '../../generated/hosts.js';
import { EngineTokenRepository } from './engine.token.repository.js';
import { HostRepository } from './host.repository.js';
import { toHost } from './hosts.service.js';

/** A name an operator can type and a command line can carry unquoted. */
const TOKEN_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The named engine tokens behind `/api/engine-tokens` (`engine.tokens.ck`), encrypted under the same
 * root key as the `engine-oauth-token` setting. Each is a row of its own, so replacing or removing
 * one leaves the rest as they were.
 *
 * Nothing the API returns carries a token: {@link resolve} is the only way to read one back, and it
 * is never reached from a contract.
 */
@Injectable()
export class EngineTokensService {
    constructor(
        private readonly tokens: EngineTokenRepository,
        private readonly encryption: EncryptionProvider,
        private readonly hosts: HostRepository,
    ) {}

    async list(): Promise<EngineTokenSummary[]> {
        return this.tokens.list();
    }

    /** Encrypt and save a token under `name`, replacing any saved there. Refuses a bad name or token with 400. */
    async put(name: string, request: PutEngineTokenRequest): Promise<EngineTokenSummary> {
        if (!TOKEN_NAME.test(name)) {
            throw httpError(400).withDetails({ reason: 'an engine token name is lowercase letters, digits, dots, dashes and underscores' });
        }
        await this.tokens.put(name, this.encryption.encrypt(requireEngineToken(request.token)));
        return (await this.tokens.list()).find(token => token.name === name)!;
    }

    /** Forget `name`. Never decrypts it, so this still works after the key is lost. Refuses an unknown name with 404. */
    async remove(name: string): Promise<void> {
        if (!(await this.tokens.remove(name))) {
            throw httpError(404).withDetails({ reason: `no engine token is saved as "${name}"` });
        }
    }

    /**
     * Sign worker host `hostName`'s engines in with the token saved as `request.name`. Refuses an
     * unknown host or token with 404, and an `ssh` host with 400.
     */
    async assign(hostName: string, request: PutHostEngineTokenRequest): Promise<Host> {
        const row = await this.hosts.find(hostName);
        if (!row) throw hostNotFound(hostName);
        if (row.kind !== 'worker') {
            throw httpError(400).withDetails({ reason: `host "${hostName}" is reached over SSH; only a worker host is assigned an engine token` });
        }
        if ((await this.tokens.ciphertext(request.name)) === undefined) {
            throw httpError(404).withDetails({ reason: `no engine token is saved as "${request.name}"` });
        }
        await this.hosts.setEngineToken(hostName, request.name);
        return toHost((await this.hosts.find(hostName))!);
    }

    /** Send host `hostName`'s engines back to the worker's own sign-in. Refuses an unknown host with 404. */
    async unassign(hostName: string): Promise<Host> {
        if (!(await this.hosts.setEngineToken(hostName, null))) throw hostNotFound(hostName);
        return toHost((await this.hosts.find(hostName))!);
    }

    /** The token worker host `hostName` is assigned now, or undefined when it has none. */
    async forHost(hostName: string): Promise<string | undefined> {
        const name = (await this.hosts.find(hostName))?.engineToken;
        return name === undefined ? undefined : this.resolve(name);
    }

    /**
     * The token saved as `name`, or undefined when none is. Refuses a row that will not decrypt, for
     * the reason `EngineTokenSettingService.resolve` does.
     */
    async resolve(name: string): Promise<string | undefined> {
        const ciphertext = await this.tokens.ciphertext(name);
        if (ciphertext === undefined) return undefined;
        try {
            return this.encryption.decrypt(ciphertext);
        } catch {
            throw new Error(`The engine token "${name}" cannot be decrypted, so the encryption key has changed. Save the token again.`);
        }
    }
}

const hostNotFound = (name: string) => httpError(404).withDetails({ reason: `host "${name}" is not registered` });
