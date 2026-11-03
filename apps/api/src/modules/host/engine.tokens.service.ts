import { Injectable } from 'injectkit';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { httpError } from '@maroonedsoftware/errors';
import { ENGINE_TOKEN_VARIABLE, type EngineCredentialVariable } from '@wilson/worker-protocol';
import { requireEngineToken } from '#modules/settings/engine.token.setting.service.js';
import type { EngineLimit, EngineTokenSummary, PutEngineTokenRequest, UpdateEngineTokenRequest } from '../../generated/engine.tokens.js';
import type { Host, PutHostEngineTokenRequest } from '../../generated/hosts.js';
import type { EngineAccount } from './execution.host.js';
import { EngineLimitRepository } from './engine.limit.repository.js';
import { EngineTokenRepository, type EngineTokenAccount } from './engine.token.repository.js';
import { HostRepository } from './host.repository.js';
import { toHost } from './hosts.service.js';

/** A name an operator can type and a command line can carry unquoted. */
const TOKEN_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const MAX_PRIORITY = 1000;

/** The providers an engine signs in to: `claude`'s, and `codex`'s. */
export type EngineProvider = 'anthropic' | 'openai';

/**
 * Whether a host can be assigned this. A host has one assigned token and it is for `claude`, so only
 * an Anthropic token can be, set as {@link credentialVariable} says. `codex` always draws from the pool.
 */
const signsInEngines = ({ provider }: { provider: string }): boolean => provider === 'anthropic';

/** What an engine is given a token as: a subscription's own variable, or the API key's. */
const credentialVariable = (kind: string): EngineCredentialVariable => (kind === 'api_key' ? 'ANTHROPIC_API_KEY' : ENGINE_TOKEN_VARIABLE);

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
        private readonly limits: EngineLimitRepository,
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
        await this.refuseChange(name, account);
        await this.tokens.put(name, this.encryption.encrypt(requireEngineToken(token)), account);
        // A new token may be a different account, so what the old one hit says nothing about it.
        await this.limits.clear(name);
        return (await this.find(name))!;
    }

    /**
     * Change what is recorded about `name`, keeping its token and limits. Refuses an unknown name with
     * 404, and with 400 a bad priority or a change that would leave a host with a token its engine cannot use.
     */
    async update(name: string, request: UpdateEngineTokenRequest): Promise<EngineTokenSummary> {
        await this.refuseChange(name, request);
        if (!(await this.tokens.update(name, request))) {
            throw httpError(404).withDetails({ reason: `no engine token is saved as "${name}"` });
        }
        return (await this.find(name))!;
    }

    /** Every usage limit in force, for any account, soonest reset first. */
    async limitsInForce(): Promise<EngineLimit[]> {
        return this.limits.active();
    }

    /** Forget `name`. Never decrypts it, so this still works after the key is lost. Refuses an unknown name with 404. */
    async remove(name: string): Promise<void> {
        if (!(await this.tokens.remove(name))) {
            throw httpError(404).withDetails({ reason: `no engine token is saved as "${name}"` });
        }
        await this.limits.clear(name);
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
                reason: `a host's engines can only sign in with an Anthropic token, and "${request.name}" is not one`,
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
        const saved = await this.find(name);
        const token = await this.resolve(name);
        return token === undefined || !saved ? undefined : { name, token, variable: credentialVariable(saved.kind) };
    }

    /**
     * The tokens Wilson may choose between, in the order to try them. An API key is one of them like any
     * other, so give it the highest priority number to keep it for when every subscription is limited: lowest priority first, then by
     * name, so the choice is the same every time it is made.
     */
    async pool(provider: EngineProvider = 'anthropic'): Promise<EngineAccount[]> {
        const pooled = (await this.tokens.list()).filter(token => token.pooled && token.provider === provider);
        pooled.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
        const accounts: EngineAccount[] = [];
        for (const { name, kind } of pooled) {
            const token = await this.resolve(name);
            if (token !== undefined) accounts.push({ name, token, ...(provider === 'anthropic' && { variable: credentialVariable(kind) }) });
        }
        return accounts;
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

    private async refuseChange(name: string, account: Partial<EngineTokenAccount>): Promise<void> {
        if (account.priority !== undefined && (account.priority < 0 || account.priority > MAX_PRIORITY)) {
            throw httpError(400).withDetails({ reason: `an engine token's priority is 0 to ${MAX_PRIORITY}` });
        }
        const saved = await this.find(name);
        // A ChatGPT sign-in would have Wilson hold and refresh session tokens, so only a key is saved.
        if (saved?.provider === 'openai' || account.provider === 'openai') {
            const { provider, kind } = { ...saved, ...account };
            if (provider === 'openai' && kind !== 'api_key') {
                throw httpError(400).withDetails({ reason: 'an OpenAI engine token must be an API key: use --kind api_key' });
            }
        }
        if (saved && saved.hosts.length > 0 && !signsInEngines({ ...saved, ...account })) {
            throw httpError(400).withDetails({
                reason: `"${name}" is assigned to ${saved.hosts.join(', ')}, whose engines can only sign in with an Anthropic token`,
            });
        }
    }

    private async find(name: string): Promise<EngineTokenSummary | undefined> {
        return (await this.tokens.list()).find(token => token.name === name);
    }
}

const hostNotFound = (name: string) => httpError(404).withDetails({ reason: `host "${name}" is not registered` });
