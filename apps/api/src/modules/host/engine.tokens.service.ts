import { Injectable } from 'injectkit';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { httpError } from '@maroonedsoftware/errors';
import { requireEngineToken } from '#modules/settings/engine.token.setting.service.js';
import type { EngineTokenSummary, PutEngineTokenRequest } from '../../generated/engine.tokens.js';
import type { Host, PutHostEngineTokenRequest } from '../../generated/hosts.js';
import type { EngineAccount } from './execution.host.js';
import { EngineTokenRepository } from './engine.token.repository.js';
import { HostRepository } from './host.repository.js';
import { toHost } from './hosts.service.js';

/** A name an operator can type and a command line can carry unquoted. */
const TOKEN_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const MAX_PRIORITY = 1000;

/**
 * Whether a host's engine can sign in with this: it arrives as `CLAUDE_CODE_OAUTH_TOKEN`, so only an
 * Anthropic subscription's token can.
 */
const signsInEngines = ({ provider, kind }: { provider: string; kind: string }): boolean => provider === 'anthropic' && kind === 'subscription';

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

    /**
     * Encrypt and save a token under `name`, replacing any saved there. Refuses with 400 a bad name,
     * token or priority, and a change that would leave a host assigned a token its engine cannot use.
     */
    async put(name: string, request: PutEngineTokenRequest): Promise<EngineTokenSummary> {
        if (!TOKEN_NAME.test(name)) {
            throw httpError(400).withDetails({ reason: 'an engine token name is lowercase letters, digits, dots, dashes and underscores' });
        }
        const { token, ...account } = request;
        if (account.priority !== undefined && (account.priority < 0 || account.priority > MAX_PRIORITY)) {
            throw httpError(400).withDetails({ reason: `an engine token's priority is 0 to ${MAX_PRIORITY}` });
        }
        const saved = await this.find(name);
        if (saved && saved.hosts.length > 0 && !signsInEngines({ ...saved, ...account })) {
            throw httpError(400).withDetails({
                reason: `"${name}" is assigned to ${saved.hosts.join(', ')}, whose engines can only sign in with an Anthropic subscription token`,
            });
        }
        await this.tokens.put(name, this.encryption.encrypt(requireEngineToken(token)), account);
        return (await this.find(name))!;
    }

    /** Forget `name`. Never decrypts it, so this still works after the key is lost. Refuses an unknown name with 404. */
    async remove(name: string): Promise<void> {
        if (!(await this.tokens.remove(name))) {
            throw httpError(404).withDetails({ reason: `no engine token is saved as "${name}"` });
        }
    }

    /**
     * Sign worker host `hostName`'s engines in with the token saved as `request.name`. Refuses an
     * unknown host or token with 404, and with 400 an `ssh` host or a token its engine cannot use.
     */
    async assign(hostName: string, request: PutHostEngineTokenRequest): Promise<Host> {
        const row = await this.hosts.find(hostName);
        if (!row) throw hostNotFound(hostName);
        if (row.kind !== 'worker') {
            throw httpError(400).withDetails({ reason: `host "${hostName}" is reached over SSH; only a worker host is assigned an engine token` });
        }
        const token = await this.find(request.name);
        if (!token) {
            throw httpError(404).withDetails({ reason: `no engine token is saved as "${request.name}"` });
        }
        if (!signsInEngines(token)) {
            throw httpError(400).withDetails({
                reason: `a host's engines can only sign in with an Anthropic subscription token, and "${request.name}" is not one`,
            });
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
    async forHost(hostName: string): Promise<EngineAccount | undefined> {
        const name = (await this.hosts.find(hostName))?.engineToken;
        if (name === undefined) return undefined;
        const token = await this.resolve(name);
        return token === undefined ? undefined : { name, token };
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

    private async find(name: string): Promise<EngineTokenSummary | undefined> {
        return (await this.tokens.list()).find(token => token.name === name);
    }
}

const hostNotFound = (name: string) => httpError(404).withDetails({ reason: `host "${name}" is not registered` });
