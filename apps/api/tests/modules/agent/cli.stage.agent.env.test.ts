import { afterEach, describe, expect, it } from 'vitest';
import { subscriptionEnv } from '#modules/agent/cli.stage.agent.js';

/**
 * Card 0194. `subscriptionEnv` copies `process.env` wholesale, and `AppConfigSourceDotenv` mutates
 * `process.env` when the daemon builds its config — so before this card every stage agent ran with
 * `DATABASE_URL` in its environment: a credentialed connection to the database holding
 * `wilson.cards`, `wilson.card_versions` and `wilson.stage_configs`.
 *
 * Nothing exploited it, because no allowlisted command takes a connection string. That is the
 * command allowlist doing the work, which PROJECT.md's decision 8 note calls a guardrail rather than
 * a boundary — and decision 6's "unreachable from a worktree by construction" is true of the disk
 * (`.env` is gitignored, absent from a worktree) and was not true of the environment.
 *
 * Every `DATABASE_*` case here fails on the pre-change tree, where the key is copied straight
 * through.
 *
 * Since then `subscriptionEnv` is an allowlist rather than a copy with deletions, so the cases below
 * that name `OPENAI_API_KEY`, `XAI_API_KEY`, `GITHUB_TOKEN`, `NOTIFY_WEBHOOK_URL` and an invented
 * future secret each failed on the denylist, which passed them straight through.
 */
const DATABASE_KEYS = ['DATABASE_URL', 'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME'];

// Each key's value before this test set it, so `PATH`, `HOME` and the rest come back afterwards
// rather than being deleted from the process the rest of the suite runs in.
const touched = new Map<string, string | undefined>();
const set = (key: string, value: string) => {
    if (!touched.has(key)) touched.set(key, process.env[key]);
    process.env[key] = value;
};

afterEach(() => {
    for (const [key, previous] of touched) {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
    }
    touched.clear();
});

/** Wilson's own credentials (PROJECT.md decision 10), each of which would let a stage act as the operator. */
const WILSON_CREDENTIAL_KEYS = [
    'AUTH_SESSION_PRIVATE_KEY',
    'AUTH_SESSION_KEY_FILE',
    'AUTH_ENCRYPTION_KEY',
    'AUTH_ENCRYPTION_KEY_FILE',
    'WILSON_API_KEY',
];

describe('subscriptionEnv', () => {
    it("strips wilson's own credentials, so a stage can neither mint a session nor call the API as the operator", () => {
        for (const key of WILSON_CREDENTIAL_KEYS) set(key, 'set-by-this-test');

        const env = subscriptionEnv();

        for (const key of WILSON_CREDENTIAL_KEYS) expect(env[key], `${key} must not reach the agent`).toBeUndefined();
    });

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

    it.each([
        ['OPENAI_API_KEY', 'another provider’s key'],
        ['XAI_API_KEY', 'another provider’s key'],
        ['GITHUB_TOKEN', 'the token card imports read issues with'],
        ['NOTIFY_WEBHOOK_URL', 'the webhook notifications post to'],
    ])('strips %s, %s', key => {
        set(key, 'set-by-this-test');

        expect(subscriptionEnv()[key], `${key} must not reach the agent`).toBeUndefined();
    });

    it('strips a secret nobody has named yet, because it is an allowlist and not a deny list', () => {
        set('SOME_FUTURE_SERVICE_SECRET', 'set-by-this-test');

        expect(subscriptionEnv().SOME_FUTURE_SERVICE_SECRET).toBeUndefined();
    });

    it('passes through what the engine needs, so this is a scrub and not a reset', () => {
        const needed = {
            PATH: '/usr/bin',
            HOME: '/home/wilson',
            USER: 'wilson',
            LOGNAME: 'wilson',
            TMPDIR: '/tmp/wilson',
            LC_CTYPE: 'en_US.UTF-8',
            HTTPS_PROXY: 'http://proxy.test:3128',
            https_proxy: 'http://proxy.test:3128',
            NO_PROXY: 'localhost',
            NODE_EXTRA_CA_CERTS: '/etc/ssl/proxy.pem',
            CLAUDE_CODE_OAUTH_TOKEN: 'engine-sign-in',
        };
        for (const [key, value] of Object.entries(needed)) set(key, value);

        const env = subscriptionEnv();

        for (const [key, value] of Object.entries(needed)) expect(env[key], key).toBe(value);
    });

    it('keeps an operator’s own CLAUDE_CONFIG_DIR, and a resolved one wins over it', () => {
        set('CLAUDE_CONFIG_DIR', '/home/wilson/.claude-operator');

        expect(subscriptionEnv().CLAUDE_CONFIG_DIR).toBe('/home/wilson/.claude-operator');
        expect(subscriptionEnv('/tmp/claude-config').CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');
    });

    it('still sets CLAUDE_CONFIG_DIR when one is resolved, and leaves it absent when not', () => {
        expect(subscriptionEnv('/tmp/claude-config').CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');
        expect('CLAUDE_CONFIG_DIR' in subscriptionEnv()).toBe(false);
    });

    it('sets CLAUDE_CODE_OAUTH_TOKEN when a token is resolved, and leaves it absent when not', () => {
        set('CLAUDE_CODE_OAUTH_TOKEN', 'placeholder');
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

        expect(subscriptionEnv(undefined, 'saved-token').CLAUDE_CODE_OAUTH_TOKEN).toBe('saved-token');
        expect('CLAUDE_CODE_OAUTH_TOKEN' in subscriptionEnv()).toBe(false);
    });

    it('keeps the environment’s own token, and a resolved one wins over it', () => {
        set('CLAUDE_CODE_OAUTH_TOKEN', 'environment-token');

        expect(subscriptionEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe('environment-token');
        expect(subscriptionEnv(undefined, 'saved-token').CLAUDE_CODE_OAUTH_TOKEN).toBe('saved-token');
    });

    it('does not strip TEST_DATABASE_*, which points at the disposable test database', () => {
        set('TEST_DATABASE_HOST', 'localhost');

        expect(subscriptionEnv().TEST_DATABASE_HOST).toBe('localhost');
    });
});
