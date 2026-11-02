import { Injectable } from 'injectkit';
import { DateTime } from 'luxon';
import type { UsageLimit } from '#modules/agent/usage.limit.js';
import { EngineTokenSettingService } from '#modules/settings/engine.token.setting.service.js';
import type { EngineAccount } from './execution.host.js';
import { EngineLimitRepository } from './engine.limit.repository.js';
import { EngineTokensService } from './engine.tokens.service.js';

/** The name of the sign-in engines on this machine use: the saved setting, the environment or the Claude login. */
export const LOCAL_ACCOUNT = 'local';

/**
 * Which account an engine started now signs in as, wherever it runs. Every engine start asks here, and
 * asks again for the next one, so a replaced token needs no restart and no reconnect.
 */
@Injectable()
export class EngineAccountsService {
    constructor(
        private readonly saved: EngineTokenSettingService,
        private readonly tokens: EngineTokensService,
        private readonly limits: EngineLimitRepository,
    ) {}

    /** The account for an engine on this machine. No token means the sign-in the machine was set up with. */
    async local(): Promise<EngineAccount> {
        const token = await this.saved.resolve();
        return { name: LOCAL_ACCOUNT, ...(token !== undefined && { token }) };
    }

    /** The account for an engine on worker host `hostName`: the token it is assigned, or the worker's own sign-in. */
    async forHost(hostName: string): Promise<EngineAccount> {
        return (await this.tokens.forHost(hostName)) ?? { name: `worker:${hostName}` };
    }

    /** Record that an account hit a limit. */
    async recordLimit({ account, limitType, resetsAt }: UsageLimit): Promise<void> {
        await this.limits.record(account, limitType, DateTime.fromMillis(resetsAt));
    }
}
