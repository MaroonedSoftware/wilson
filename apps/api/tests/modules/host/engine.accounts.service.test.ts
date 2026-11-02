import { describe, expect, it } from 'vitest';
import { EngineAccountsService } from '#modules/host/engine.accounts.service.js';

const service = (saved: string | undefined, assigned?: { name: string; token: string }) =>
    new EngineAccountsService({ resolve: async () => saved } as never, { forHost: async () => assigned } as never, {} as never);

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
});
