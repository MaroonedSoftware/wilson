import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { SdkError, type AppGrant } from '@wilson/sdk';
import {
    answerAppRequest,
    APP_METHOD_NAMES,
    MAX_APP_REQUESTS_IN_FLIGHT,
    serveApp,
    type AppBrokerClient,
    type AppResponse,
} from '#src/lib/app.broker.js';

/** What an app can get out of the host. Everything it sends is treated as hostile. */

const ALL: AppGrant[] = ['board.read', 'activity.read', 'stats.read'];

const fakeClient = () => {
    const board = {
        listCards: vi.fn(async () => [{ id: '0001' }]),
        getCard: vi.fn(async (id: string) => ({ id })),
        listBoardColumns: vi.fn(async () => ({ columns: [] })),
        listProjectActivity: vi.fn(async () => []),
        getProjectStats: vi.fn(async () => ({ days: 7 })),
    };
    return { client: { board } as unknown as AppBrokerClient, board };
};

const ask = async (method: string, args: unknown[] = [], grants: AppGrant[] = ALL, client = fakeClient().client) =>
    (await answerAppRequest({ id: 1, method, args }, grants, client)) as AppResponse;

const failure = async (method: string, args: unknown[] = [], grants: AppGrant[] = ALL) => {
    const { client, board } = fakeClient();
    const response = await ask(method, args, grants, client);
    expect(response.ok).toBe(false);
    for (const call of Object.values(board)) expect(call).not.toHaveBeenCalled();
    return (response as { error: string }).error;
};

describe('what each grant allows', () => {
    it.each([
        ['listCards', 'board.read'],
        ['getCard', 'board.read'],
        ['listBoardColumns', 'board.read'],
        ['listProjectActivity', 'activity.read'],
        ['getProjectStats', 'stats.read'],
    ] as const)('%s needs %s and nothing else will do', async (method, grant) => {
        const args = method === 'getCard' ? ['0001'] : [];

        expect((await ask(method, args, [grant])).ok).toBe(true);
        expect(
            await failure(
                method,
                args,
                ALL.filter(other => other !== grant),
            ),
        ).toContain(grant);
        expect(await failure(method, args, [])).toContain(grant);
    });

    it('offers exactly those methods', () => {
        expect([...APP_METHOD_NAMES].sort()).toEqual(['getCard', 'getProjectStats', 'listBoardColumns', 'listCards', 'listProjectActivity']);
    });
});

describe('methods that are not on the list', () => {
    it.each(['moveCard', 'mergeCard', 'createCard', 'apiKeys', 'constructor', '__proto__', 'toString', 'hasOwnProperty', ''])(
        'refuses %j',
        async method => {
            expect(await failure(method)).toContain('no method');
        },
    );
});

describe('arguments', () => {
    it.each([['..'], ['.'], ['../auth/keys'], ['0001/events'], ['a?b=c'], ['a#b'], ['a b'], [''], ['x'.repeat(65)], [1], [{}], [null]])(
        'refuses %j as a card id',
        async id => {
            expect(await failure('getCard', [id])).toContain('card id');
        },
    );

    it('refuses a card call with no id, or a second argument', async () => {
        await failure('getCard', []);
        await failure('getCard', ['0001', 'extra']);
    });

    it('refuses arguments to a method that takes none', async () => {
        await failure('listCards', [{ project: 'other' }]);
        await failure('listBoardColumns', ['x']);
    });

    it('passes a query through', async () => {
        const { client, board } = fakeClient();

        await ask('listProjectActivity', [{ limit: 5, before: 10 }], ALL, client);
        await ask('getProjectStats', [{ days: 30 }], ALL, client);

        expect(board.listProjectActivity).toHaveBeenCalledWith({ limit: 5, before: 10 });
        expect(board.getProjectStats).toHaveBeenCalledWith({ days: 30 });
    });

    it.each([
        ['listProjectActivity', { project: 'other' }],
        ['listProjectActivity', { limit: '5&project=other' }],
        ['listProjectActivity', { limit: -1 }],
        ['listProjectActivity', { limit: 1.5 }],
        ['listProjectActivity', { limit: Infinity }],
        ['listProjectActivity', 'limit=5'],
        ['listProjectActivity', [5]],
        ['listProjectActivity', null],
        ['getProjectStats', { limit: 5 }],
    ])('refuses %s with %j', async (method, query) => {
        await failure(method, [query]);
    });
});

describe('answers', () => {
    it('sends plain data, with dates as ISO strings', async () => {
        const { client, board } = fakeClient();
        board.listCards.mockResolvedValue([{ id: '0001', at: DateTime.fromISO('2026-11-05T00:00:00.000Z', { zone: 'utc' }) }] as never);

        expect(await ask('listCards', [], ALL, client)).toEqual({ id: 1, ok: true, result: [{ id: '0001', at: '2026-11-05T00:00:00.000Z' }] });
    });

    it("sends the server's reason, and none of the error's headers", async () => {
        const { client, board } = fakeClient();
        board.getCard.mockRejectedValue(new SdkError(404, 'Not Found', { details: { reason: 'no card' } }, new Headers({ 'x-secret': 'hidden' })));

        expect(await ask('getCard', ['0001'], ALL, client)).toEqual({ id: 1, ok: false, error: 'no card' });
    });

    it.each([
        undefined,
        null,
        'text',
        5,
        {},
        { id: 'x', method: 'listCards', args: [] },
        { id: 1, method: 5, args: [] },
        { id: 1, method: 'listCards' },
    ])('ignores %j, which is not a request', async data => {
        const { client, board } = fakeClient();

        expect(await answerAppRequest(data, ALL, client)).toBeUndefined();
        expect(board.listCards).not.toHaveBeenCalled();
    });
});

describe('serveApp', () => {
    const connect = (client: AppBrokerClient, grants: AppGrant[] = ALL) => {
        const { port1, port2 } = new MessageChannel();
        serveApp(port1 as unknown as MessagePort, grants, client);
        const replies: AppResponse[] = [];
        port2.onmessage = ({ data }) => replies.push(data as AppResponse);
        return { app: port2, host: port1, replies };
    };

    it('answers over the port', async () => {
        const { client } = fakeClient();
        const { app, host, replies } = connect(client);

        app.postMessage({ id: 7, method: 'listCards', args: [] });

        await vi.waitFor(() => expect(replies).toEqual([{ id: 7, ok: true, result: [{ id: '0001' }] }]));
        host.close();
    });

    it('refuses requests past the limit without calling the API, and recovers', async () => {
        const { client, board } = fakeClient();
        const release: (() => void)[] = [];
        board.listCards.mockImplementation(() => new Promise(resolve => release.push(() => resolve([{ id: '0001' }]))));
        const { app, host, replies } = connect(client);

        for (let id = 1; id <= MAX_APP_REQUESTS_IN_FLIGHT + 2; id += 1) app.postMessage({ id, method: 'listCards', args: [] });

        await vi.waitFor(() => expect(replies).toHaveLength(2));
        expect(replies.every(reply => !reply.ok && reply.error === 'too many requests at once')).toBe(true);
        expect(board.listCards).toHaveBeenCalledTimes(MAX_APP_REQUESTS_IN_FLIGHT);

        for (const finish of release) finish();
        await vi.waitFor(() => expect(replies).toHaveLength(MAX_APP_REQUESTS_IN_FLIGHT + 2));
        app.postMessage({ id: 99, method: 'listCards', args: [] });
        await vi.waitFor(() => expect(board.listCards).toHaveBeenCalledTimes(MAX_APP_REQUESTS_IN_FLIGHT + 1));
        release.at(-1)!();
        host.close();
    });
});
