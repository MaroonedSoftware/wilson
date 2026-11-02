import { Injectable } from 'injectkit';
import { DateTime } from 'luxon';
import type { UsageLimit } from '#modules/agent/usage.limit.js';
import { EngineTokenSettingService } from '#modules/settings/engine.token.setting.service.js';
import type { EngineAccount } from './execution.host.js';
import { EngineLimitRepository, type EngineLimitRow } from './engine.limit.repository.js';
import { EngineTokensService } from './engine.tokens.service.js';

/** The name of the sign-in engines on this machine use: the saved setting, the environment or the Claude login. */
export const LOCAL_ACCOUNT = 'local';

/**
 * Which account an engine started now signs in as, wherever it runs. Every engine start asks here, and
 * asks again for the next one, so a replaced token needs no restart and no reconnect.
 *
 * A token assigned to a host is that host's alone. Any other engine takes the first pooled token with
 * no limit in force, so cards stay on one account until it runs out and a stage is rarely moved between
 * accounts. With every pooled token limited, it gets the one that resets soonest, limit and all, and
 * its caller waits for that. With none pooled, it signs in as that machine was set up to.
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
        const pooled = await this.fromPool();
        if (pooled) return pooled;
        const token = await this.saved.resolve();
        return this.withLimit({ name: LOCAL_ACCOUNT, ...(token !== undefined && { token }) });
    }

    /** The account for an engine on worker host `hostName`: the token it is assigned, or the worker's own sign-in. */
    async forHost(hostName: string): Promise<EngineAccount> {
        const assigned = await this.tokens.forHost(hostName);
        if (assigned) return this.withLimit(assigned);
        return (await this.fromPool()) ?? this.withLimit({ name: `worker:${hostName}` });
    }

    /** Record that an account hit a limit. */
    async recordLimit({ account, limitType, resetsAt }: UsageLimit): Promise<void> {
        await this.limits.record(account, limitType, DateTime.fromMillis(resetsAt));
    }

    private async fromPool(): Promise<EngineAccount | undefined> {
        const pool = await this.tokens.pool();
        if (pool.length === 0) return undefined;
        const active = await this.limits.active();
        const accounts = pool.map(account => limited(account, active));
        return (
            accounts.find(account => !account.limit) ??
            accounts.reduce((soonest, next) => (next.limit!.resetsAt < soonest.limit!.resetsAt ? next : soonest))
        );
    }

    private async withLimit(account: EngineAccount): Promise<EngineAccount> {
        return limited(account, await this.limits.active());
    }
}

/** `account`, with the limit that keeps it out longest if any has not reset. `active` is soonest reset first. */
const limited = (account: EngineAccount, active: EngineLimitRow[]): EngineAccount => {
    const last = active.filter(limit => limit.account === account.name).at(-1);
    if (!last) return account;
    return { ...account, limit: { account: account.name, limitType: last.limitType, resetsAt: last.resetsAt.toMillis() } };
};
