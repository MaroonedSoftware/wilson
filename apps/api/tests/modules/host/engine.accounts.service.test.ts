import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { EngineAccountsService } from '#modules/host/engine.accounts.service.js';

const service = (saved: string | undefined, assigned?: { name: string; token: string }, active: unknown[] = []) =>
    new EngineAccountsService(
        { resolve: async () => saved } as never,
        { forHost: async () => assigned } as never,
        { active: async () => active } as never,
    );

describe('EngineAccountsService', () => {
    it('names this machine’s account, with the saved token when there is one', async () => {
        await expect(service('saved').local()).resolves.toEqual({ name: 'local', token: 'saved' });
        await expect(service(undefined).local()).resolves.toEqual({ name: 'local' });
    });

    it('uses the token a worker host is assigned, and otherwise names the worker’s own sign-in', async () => {
        const assigned = { name: 'pool-a', token: 'value' };

        await expect(service(undefined, assigned).forHost('vm')).resolves.toEqual(assigned);
        await expect(service('saved').forHost('vm')).resolves.toEqual({ name: 'worker:vm' });
    });

    it('says when an account has a limit in force, naming the last to reset, and ignores other accounts’', async () => {
        const at = (ms: number) => DateTime.fromMillis(ms);
        const active = [
            { account: 'local', limitType: 'five_hour', resetsAt: at(1000) },
            { account: 'pool-a', limitType: 'five_hour', resetsAt: at(1500) },
            { account: 'local', limitType: 'seven_day', resetsAt: at(2000) },
        ];

        await expect(service(undefined, undefined, active).local()).resolves.toEqual({
            name: 'local',
            limit: { account: 'local', limitType: 'seven_day', resetsAt: 2000 },
        });
        await expect(service(undefined, undefined, active).forHost('vm')).resolves.toEqual({ name: 'worker:vm' });
    });
});
