import { afterEach, describe, expect, it } from 'vitest';
import { subscriptionEnv } from '#modules/agent/cli.stage.agent.js';

/**
 * Card 0194. `subscriptionEnv` copies `process.env` wholesale, and `AppConfigSourceDotenv` mutates
 * `process.env` when the daemon builds its config — so before this card every stage agent ran with
 * `DATABASE_URL` in its environment: a credentialed connection to the database holding
 * `runner.cards`, `runner.card_versions` and `runner.stage_configs`.
 *
 * Nothing exploited it, because no allowlisted command takes a connection string. That is the
 * command allowlist doing the work, which PROJECT.md's decision 8 note calls a guardrail rather than
 * a boundary — and decision 6's "unreachable from a worktree by construction" is true of the disk
 * (`.env` is gitignored, absent from a worktree) and was not true of the environment.
 *
 * Every `DATABASE_*` case here fails on the pre-change tree, where the key is copied straight
 * through.
 */
const DATABASE_KEYS = ['DATABASE_URL', 'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME'];

const touched: string[] = [];
const set = (key: string, value: string) => {
    touched.push(key);
    process.env[key] = value;
};

afterEach(() => {
    for (const key of touched) delete process.env[key];
    touched.length = 0;
});

describe('subscriptionEnv', () => {
    it('strips every DATABASE_* key, so an agent never holds the board’s connection string', () => {
        for (const key of DATABASE_KEYS) set(key, 'set-by-this-test');

        const env = subscriptionEnv();

        for (const key of DATABASE_KEYS) expect(env[key], `${key} must not reach the agent`).toBeUndefined();
    });

    it('strips the token a remote engine signs in with, which only ever reaches a host over stdin', () => {
        set('REMOTE_CLAUDE_CODE_OAUTH_TOKEN', 'remote-token');

        expect(subscriptionEnv().REMOTE_CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('still strips the provider keys it always did', () => {
        set('ANTHROPIC_API_KEY', 'sk-test');
        set('ANTHROPIC_AUTH_TOKEN', 'token-test');

        const env = subscriptionEnv();

        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    it('passes through what the engine needs, so this is a scrub and not a reset', () => {
        set('PATH', '/usr/bin');
        set('HOME', '/home/wilson');

        const env = subscriptionEnv();

        expect(env.PATH).toBe('/usr/bin');
        expect(env.HOME).toBe('/home/wilson');
    });

    it('still sets CLAUDE_CONFIG_DIR when one is resolved, and leaves it absent when not', () => {
        expect(subscriptionEnv('/tmp/claude-config').CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');
        expect('CLAUDE_CONFIG_DIR' in subscriptionEnv()).toBe(false);
    });

    it('does not strip TEST_DATABASE_*, which points at the disposable test database', () => {
        set('TEST_DATABASE_HOST', 'localhost');

        expect(subscriptionEnv().TEST_DATABASE_HOST).toBe('localhost');
    });
});
