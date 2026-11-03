import { DateTime } from 'luxon';
import type { EngineLimit, EngineTokenKind, EngineTokenProvider, EngineTokenSummary } from '@wilson/sdk';

export const ENGINE_TOKENS_QUERY_KEY = ['engine-tokens'];
export const ENGINE_LIMITS_QUERY_KEY = ['engine-limits'];

/** What a limit is recorded against for engines on the server's own machine (`EngineAccountsService`). */
export const LOCAL_ACCOUNT = 'local';

const MAX_PRIORITY = 1000;

/** The kinds of account the Accounts section can add, as the names the API keeps them under. */
export const ACCOUNT_TYPES: { value: string; label: string; provider: EngineTokenProvider; kind: EngineTokenKind }[] = [
    { value: 'claude-subscription', label: 'Claude subscription', provider: 'anthropic', kind: 'subscription' },
    { value: 'anthropic-key', label: 'Anthropic API key', provider: 'anthropic', kind: 'api_key' },
    { value: 'openai-key', label: 'OpenAI API key', provider: 'openai', kind: 'api_key' },
];

const LIMIT_NAMES: Record<string, string> = {
    five_hour: '5-hour limit',
    seven_day: 'Weekly limit',
    seven_day_opus: 'Weekly Opus limit',
    seven_day_sonnet: 'Weekly Sonnet limit',
    seven_day_overage_included: 'Weekly limit',
    overage: 'Overage limit',
    rateLimitExceeded: 'Rate limit',
};

/** A saved token's kind of account, in words. */
export const accountType = ({ provider, kind }: Pick<EngineTokenSummary, 'provider' | 'kind'>): string =>
    ACCOUNT_TYPES.find(type => type.provider === provider && type.kind === kind)?.label ?? `${provider} ${kind === 'api_key' ? 'API key' : 'subscription'}`;

/** A limit and when it lifts, such as "Weekly limit, back Thu 5:00 PM". Anything the engine calls it that is not listed is a usage limit. */
export const describeLimit = ({ limitType, resetsAt }: Pick<EngineLimit, 'limitType' | 'resetsAt'>, now: DateTime = DateTime.now()): string => {
    const name = LIMIT_NAMES[limitType] ?? 'Usage limit';
    const local = resetsAt.setZone(now.zone);
    if (local.hasSame(now, 'day')) return `${name}, back ${local.toFormat('t')}`;
    return `${name}, back ${local.toFormat(local.diff(now, 'days').days < 6 ? 'ccc t' : 'LLL d, t')}`;
};

/** What a limit's account is called when it is a machine's own sign-in, which has no saved token to show it beside. */
export const describeSignIn = (account: string): string => {
    if (account === LOCAL_ACCOUNT) return 'This server';
    if (account.startsWith('worker:')) return `${account.slice('worker:'.length)}'s own sign-in`;
    if (account.startsWith('codex:')) return `Codex on ${account.slice('codex:'.length)}`;
    return account;
};

/** The limit keeping `account` out longest, as the server chooses it, if any has not reset by `now`. */
export const limitOn = (account: string, limits: EngineLimit[], now: DateTime = DateTime.now()): EngineLimit | undefined =>
    limits
        .filter(limit => limit.account === account && limit.resetsAt > now)
        .reduce<EngineLimit | undefined>((longest, limit) => (longest && longest.resetsAt >= limit.resetsAt ? longest : limit), undefined);

/** A provider's tokens Wilson may choose between, in the order it tries them (`EngineTokensService.pool`). */
export const rotationOf = (tokens: EngineTokenSummary[], provider: EngineTokenProvider = 'anthropic'): EngineTokenSummary[] =>
    tokens.filter(token => token.pooled && token.provider === provider).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

/** The saved tokens Wilson will not choose by itself, whether or not a host is assigned them. An xAI token is one of these, since no engine draws on it. */
export const outsideRotation = (tokens: EngineTokenSummary[]): EngineTokenSummary[] =>
    tokens.filter(token => !token.pooled || (token.provider !== 'anthropic' && token.provider !== 'openai'));

/**
 * Which account of `rotation` the next engine with none assigned takes (`EngineAccountsService.fromPool`):
 * the first with no limit in force, or with every one limited the one back soonest, whose `limit` then
 * says when. Nothing with an empty rotation, since engines then use their machine's own sign-in.
 */
export const nextAccount = (
    rotation: EngineTokenSummary[],
    limits: EngineLimit[],
    now: DateTime = DateTime.now(),
): { name: string; limit?: EngineLimit } | undefined => {
    const accounts = rotation.map(({ name }) => ({ name, limit: limitOn(name, limits, now) }));
    if (accounts.length === 0) return undefined;
    const free = accounts.find(account => !account.limit);
    if (free) return { name: free.name };
    return accounts.reduce((soonest, next) => (next.limit!.resetsAt < soonest.limit!.resetsAt ? next : soonest));
};

/** The priority that puts a token last in `rotation`, so a new account never jumps ahead of the ones already working. */
export const lastPriority = (rotation: EngineTokenSummary[]): number =>
    rotation.length === 0 ? 0 : Math.min(MAX_PRIORITY, rotation[rotation.length - 1]!.priority + 1);

/**
 * The priorities to save to move the token at `index` of `rotation` by `offset`: the new order numbered
 * from 0, leaving out any that already has its number. Priorities can tie, and ties order by name, so
 * swapping two numbers would not always move anything. Nothing when the move runs off either end.
 */
export const movedPriorities = (rotation: EngineTokenSummary[], index: number, offset: number): { name: string; priority: number }[] => {
    const target = index + offset;
    if (index < 0 || index >= rotation.length || target < 0 || target >= rotation.length) return [];
    const order = [...rotation];
    const [moved] = order.splice(index, 1);
    order.splice(target, 0, moved!);
    return order.map(({ name, priority }, position) => ({ name, priority, position })).filter(each => each.priority !== each.position).map(({ name, position }) => ({ name, priority: position }));
};
