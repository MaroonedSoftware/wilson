import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { EngineLimit, EngineTokenSummary } from '@wilson/sdk';
import {
    accountType,
    describeLimit,
    describeSignIn,
    lastPriority,
    limitOn,
    movedPriorities,
    nextAccount,
    outsideRotation,
    rotationOf,
} from '../src/lib/accounts.js';

const NOW = DateTime.fromISO('2026-11-03T12:00:00', { zone: 'America/New_York' });

const token = (name: string, overrides: Partial<EngineTokenSummary> = {}): EngineTokenSummary => ({
    name,
    provider: 'anthropic',
    kind: 'subscription',
    priority: 0,
    pooled: true,
    createdAt: NOW,
    updatedAt: NOW,
    hosts: [],
    ...overrides,
});

const limit = (account: string, resetsAt: DateTime, limitType = 'seven_day'): EngineLimit => ({ account, limitType, resetsAt });

describe('rotationOf', () => {
    it('orders by priority, then name, as the server does', () => {
        const tokens = [token('c', { priority: 1 }), token('b'), token('a')];
        expect(rotationOf(tokens).map(each => each.name)).toEqual(['a', 'b', 'c']);
    });

    it('leaves out tokens not pooled and other providers', () => {
        const tokens = [token('claude'), token('held', { pooled: false }), token('codex', { provider: 'openai', kind: 'api_key' })];
        expect(rotationOf(tokens).map(each => each.name)).toEqual(['claude']);
        expect(rotationOf(tokens, 'openai').map(each => each.name)).toEqual(['codex']);
    });
});

describe('outsideRotation', () => {
    it('holds tokens not pooled, and a pooled token no engine draws on', () => {
        const tokens = [token('claude'), token('held', { pooled: false }), token('grok', { provider: 'xai', kind: 'api_key' })];
        expect(outsideRotation(tokens).map(each => each.name)).toEqual(['held', 'grok']);
    });
});

describe('limitOn', () => {
    it('is the limit that keeps the account out longest', () => {
        const limits = [limit('a', NOW.plus({ hours: 1 }), 'five_hour'), limit('a', NOW.plus({ days: 2 })), limit('b', NOW.plus({ days: 5 }))];
        expect(limitOn('a', limits, NOW)?.limitType).toBe('seven_day');
    });

    it('ignores a limit that has reset since it was read', () => {
        expect(limitOn('a', [limit('a', NOW.minus({ minutes: 1 }))], NOW)).toBeUndefined();
    });
});

describe('nextAccount', () => {
    it('is nothing for an empty rotation', () => {
        expect(nextAccount([], [], NOW)).toBeUndefined();
    });

    it('is the first with no limit, however much earlier the others reset', () => {
        const rotation = [token('a'), token('b'), token('c')];
        const limits = [limit('a', NOW.plus({ minutes: 1 }))];
        expect(nextAccount(rotation, limits, NOW)).toEqual({ name: 'b' });
    });

    it('is the one back soonest when every one is limited, with its limit', () => {
        const rotation = [token('a'), token('b')];
        const soonest = limit('b', NOW.plus({ hours: 1 }));
        expect(nextAccount(rotation, [limit('a', NOW.plus({ days: 1 })), soonest], NOW)).toEqual({ name: 'b', limit: soonest });
    });
});

describe('lastPriority', () => {
    it('starts an empty rotation at 0', () => {
        expect(lastPriority([])).toBe(0);
    });

    it('goes after the last, and no further than the API allows', () => {
        expect(lastPriority([token('a', { priority: 4 })])).toBe(5);
        expect(lastPriority([token('a', { priority: 1000 })])).toBe(1000);
    });
});

describe('movedPriorities', () => {
    it('numbers the new order, so a move works among tied priorities', () => {
        const rotation = rotationOf([token('a'), token('b'), token('c')]);
        expect(movedPriorities(rotation, 2, -1)).toEqual([
            { name: 'c', priority: 1 },
            { name: 'b', priority: 2 },
        ]);
    });

    it('sends only the priorities that change', () => {
        const rotation = rotationOf([token('a', { priority: 0 }), token('b', { priority: 1 }), token('c', { priority: 2 })]);
        expect(movedPriorities(rotation, 0, 1)).toEqual([
            { name: 'b', priority: 0 },
            { name: 'a', priority: 1 },
        ]);
    });

    it('does nothing off either end', () => {
        const rotation = [token('a'), token('b')];
        expect(movedPriorities(rotation, 0, -1)).toEqual([]);
        expect(movedPriorities(rotation, 1, 1)).toEqual([]);
    });
});

describe('describeLimit', () => {
    it.each([
        ['five_hour', '5-hour limit'],
        ['seven_day', 'Weekly limit'],
        ['seven_day_opus', 'Weekly Opus limit'],
        ['unknown', 'Usage limit'],
        ['anything_else', 'Usage limit'],
    ])('names %s', (limitType, name) => {
        expect(describeLimit({ limitType, resetsAt: NOW.plus({ hours: 1 }) }, NOW)).toContain(name);
    });

    it('gives only the time when it is back today', () => {
        expect(describeLimit({ limitType: 'five_hour', resetsAt: NOW.plus({ hours: 5 }) }, NOW)).toBe('5-hour limit, back 5:00 PM');
    });

    it('gives the day when it is back this week', () => {
        expect(describeLimit({ limitType: 'seven_day', resetsAt: NOW.plus({ days: 2, hours: 5 }) }, NOW)).toBe('Weekly limit, back Thu 5:00 PM');
    });

    it('gives the date when the day alone would be ambiguous', () => {
        expect(describeLimit({ limitType: 'seven_day', resetsAt: NOW.plus({ days: 7 }) }, NOW)).toBe('Weekly limit, back Nov 10, 12:00 PM');
    });

    it('reads a reset in the viewer’s zone, whatever zone it arrived in', () => {
        expect(describeLimit({ limitType: 'five_hour', resetsAt: NOW.plus({ hours: 5 }).toUTC() }, NOW)).toBe('5-hour limit, back 5:00 PM');
    });
});

describe('describeSignIn', () => {
    it.each([
        ['local', 'This server'],
        ['worker:my-mac', "my-mac's own sign-in"],
        ['codex:my-mac', 'Codex on my-mac'],
        ['removed-token', 'removed-token'],
    ])('calls %s %s', (account, words) => {
        expect(describeSignIn(account)).toBe(words);
    });
});

describe('accountType', () => {
    it('names the kinds the form can add, and any other in plain terms', () => {
        expect(accountType(token('a'))).toBe('Claude subscription');
        expect(accountType(token('a', { kind: 'api_key' }))).toBe('Anthropic API key');
        expect(accountType(token('a', { provider: 'openai', kind: 'api_key' }))).toBe('OpenAI API key');
        expect(accountType(token('a', { provider: 'xai', kind: 'api_key' }))).toBe('xai API key');
    });
});
