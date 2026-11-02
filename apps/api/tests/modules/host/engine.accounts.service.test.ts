import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { EngineAccountsService } from '#modules/host/engine.accounts.service.js';

const service = (saved: string | undefined, assigned?: { name: string; token: string }, active: unknown[] = [], pool: unknown[] = []) =>
    new EngineAccountsService(
        { resolve: async () => saved } as never,
        { forHost: async () => assigned, pool: async () => pool } as never,
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

    describe('with a pool', () => {
        const pool = [
            { name: 'first', token: 'first-token' },
            { name: 'second', token: 'second-token' },
        ];
        const at = (ms: number) => DateTime.fromMillis(ms);

        it('takes the first pooled token, here and on a worker, over this machine’s sign-in', async () => {
            await expect(service('saved', undefined, [], pool).local()).resolves.toEqual(pool[0]);
            await expect(service(undefined, undefined, [], pool).forHost('vm')).resolves.toEqual(pool[0]);
        });

        it('leaves a host with an assigned token on it, even when that token is limited', async () => {
            const assigned = { name: 'pinned', token: 'pinned-token' };
            const active = [{ account: 'pinned', limitType: 'five_hour', resetsAt: at(1000) }];

            await expect(service(undefined, assigned, active, pool).forHost('vm')).resolves.toMatchObject({
                name: 'pinned',
                limit: { resetsAt: 1000 },
            });
        });

        it('moves past a limited token to the next', async () => {
            const active = [{ account: 'first', limitType: 'five_hour', resetsAt: at(1000) }];

            await expect(service(undefined, undefined, active, pool).local()).resolves.toEqual(pool[1]);
        });

        it('with all of them limited, names the one that resets soonest', async () => {
            const active = [
                { account: 'second', limitType: 'five_hour', resetsAt: at(1000) },
                { account: 'first', limitType: 'five_hour', resetsAt: at(1500) },
            ];

            await expect(service(undefined, undefined, active, pool).local()).resolves.toMatchObject({ name: 'second', limit: { resetsAt: 1000 } });
        });

        it('judges a token with several limits by the last of them to reset', async () => {
            const active = [
                { account: 'first', limitType: 'five_hour', resetsAt: at(1000) },
                { account: 'second', limitType: 'five_hour', resetsAt: at(1500) },
                { account: 'first', limitType: 'seven_day', resetsAt: at(9000) },
            ];

            await expect(service(undefined, undefined, active, pool).local()).resolves.toMatchObject({ name: 'second', limit: { resetsAt: 1500 } });
        });
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
