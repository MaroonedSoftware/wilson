import type { AppGrant, WilsonSdk } from '@wilson/sdk';
import { reasonFor } from './mutations.js';

/** The part of the SDK an app can ever reach. Nothing else is in scope here to be asked for. */
export type AppBrokerClient = {
    appApi: Pick<WilsonSdk['appApi'], 'listCardsV1' | 'getCardV1' | 'listBoardColumnsV1' | 'listProjectActivityV1' | 'getProjectStatsV1'>;
};

/** One thing an app can ask for: the grant it takes, and how arguments from the app become a call. */
interface AppMethod {
    grant: AppGrant;
    run: (client: AppBrokerClient, args: readonly unknown[]) => Promise<unknown>;
}

/** Refused rather than sent on. Its message goes back to the app. */
class AppRequestError extends Error {}

/**
 * A card id, and nothing a URL would read as more. `encodeURIComponent` leaves `..` as it is, and the
 * browser then resolves it, so `getCard('..')` would otherwise fetch a route that is not a card.
 */
const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const noArguments = (args: readonly unknown[]): void => {
    if (args.length > 0) throw new AppRequestError('this method takes no arguments');
};

const cardId = (args: readonly unknown[]): string => {
    const [id] = args;
    if (args.length !== 1 || typeof id !== 'string' || !CARD_ID.test(id)) throw new AppRequestError('expected one card id');
    return id;
};

/** An optional query holding only these keys, each a whole number. Anything else is refused. */
const wholeNumbers = <K extends string>(args: readonly unknown[], keys: readonly K[]): Partial<Record<K, number>> | undefined => {
    if (args.length > 1) throw new AppRequestError('expected at most one query');
    const [query] = args;
    if (query === undefined) return undefined;
    if (typeof query !== 'object' || query === null || Array.isArray(query)) throw new AppRequestError('expected a query object');
    const result: Partial<Record<K, number>> = {};
    for (const [key, value] of Object.entries(query)) {
        if (!keys.includes(key as K)) throw new AppRequestError(`unknown query field "${key}"`);
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AppRequestError(`${key} must be a whole number`);
        result[key as K] = value;
    }
    return result;
};

/**
 * Everything an app can ask for. An app holds no credential, so this table is the whole of its
 * authority: a method missing here, or a grant the app was not installed with, cannot be reached by
 * anything it sends. A `Map`, so a name like `constructor` finds nothing.
 */
const METHODS = new Map<string, AppMethod>([
    [
        'listCards',
        {
            grant: 'board.read',
            run: (client, args) => {
                noArguments(args);
                return client.appApi.listCardsV1();
            },
        },
    ],
    ['getCard', { grant: 'board.read', run: (client, args) => client.appApi.getCardV1(cardId(args)) }],
    [
        'listBoardColumns',
        {
            grant: 'board.read',
            run: (client, args) => {
                noArguments(args);
                return client.appApi.listBoardColumnsV1();
            },
        },
    ],
    [
        'listProjectActivity',
        { grant: 'activity.read', run: (client, args) => client.appApi.listProjectActivityV1(wholeNumbers(args, ['limit', 'before'])) },
    ],
    ['getProjectStats', { grant: 'stats.read', run: (client, args) => client.appApi.getProjectStatsV1(wholeNumbers(args, ['days'])) }],
]);

/** The method names `window.wilson` offers, granted or not. */
export const APP_METHOD_NAMES: readonly string[] = [...METHODS.keys()];

/** The most requests one app may have waiting, so a loop in it cannot pile work onto the API. */
export const MAX_APP_REQUESTS_IN_FLIGHT = 16;

export type AppResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

const isRequest = (data: unknown): data is { id: number; method: string; args: readonly unknown[] } => {
    const request = data as { id?: unknown; method?: unknown; args?: unknown } | null | undefined;
    return typeof request?.id === 'number' && typeof request.method === 'string' && Array.isArray(request.args);
};

/**
 * Answer one message from an app, or nothing if it is not a request and so has no id to answer. The
 * result goes through JSON so an app receives plain data, with `DateTime`s as ISO strings, and none of
 * the SDK's own objects.
 */
export const answerAppRequest = async (data: unknown, grants: readonly AppGrant[], client: AppBrokerClient): Promise<AppResponse | undefined> => {
    if (!isRequest(data)) return undefined;
    const { id, method: name, args } = data;
    const method = METHODS.get(name);
    if (!method) return { id, ok: false, error: `no method "${name}"` };
    if (!grants.includes(method.grant))
        return { id, ok: false, error: `${name} needs the ${method.grant} grant, which this app was not installed with` };
    try {
        return { id, ok: true, result: JSON.parse(JSON.stringify(await method.run(client, args))) as unknown };
    } catch (err) {
        return { id, ok: false, error: reasonFor(err) };
    }
};

/** Serve an app's requests over its port until the port closes. */
export const serveApp = (port: MessagePort, grants: readonly AppGrant[], client: AppBrokerClient): void => {
    let inFlight = 0;
    port.onmessage = async ({ data }: MessageEvent<unknown>) => {
        if (inFlight >= MAX_APP_REQUESTS_IN_FLIGHT) {
            if (isRequest(data)) port.postMessage({ id: data.id, ok: false, error: 'too many requests at once' } satisfies AppResponse);
            return;
        }
        inFlight += 1;
        const response = await answerAppRequest(data, grants, client);
        inFlight -= 1;
        if (response) port.postMessage(response);
    };
};
