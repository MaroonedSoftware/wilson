import { describe, expect, it } from 'vitest';
import { commandEnvironment, engineEnvironment } from '../src/worker.env.js';

const own = { PATH: '/worker/bin', HOME: '/home/worker', GITHUB_TOKEN: 'worker-gh', CLAUDE_CODE_OAUTH_TOKEN: 'worker-engine', SECRET: 'worker-only' };

describe('commandEnvironment', () => {
    it('keeps what Wilson sent, but takes the passthrough names from the worker', () => {
        const env = commandEnvironment({ PATH: '/wilson/bin', HOME: '/home/wilson', CI: 'true', PORT: '4001' }, [], own);

        expect(env).toEqual({ PATH: '/worker/bin', HOME: '/home/worker', CI: 'true', PORT: '4001' });
    });

    it('takes hostEnv names from the worker too, and nothing else of the worker’s', () => {
        const env = commandEnvironment({ GITHUB_TOKEN: 'from-wilson' }, ['GITHUB_TOKEN'], own);

        expect(env.GITHUB_TOKEN).toBe('worker-gh');
        expect(env).not.toHaveProperty('SECRET');
        expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('leaves a passthrough name unset when the worker has none, rather than using Wilson’s', () => {
        expect(commandEnvironment({ TZ: 'America/New_York' }, [], {})).toEqual({});
    });
});

describe('engineEnvironment', () => {
    it('carries only the SDK’s own variables from Wilson, and the worker’s own token', () => {
        const env = engineEnvironment(
            {
                CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
                CLAUDE_AGENT_SDK_VERSION: '0.3.241',
                CLAUDE_CODE_OAUTH_TOKEN: 'from-wilson',
                CLAUDE_CONFIG_DIR: '/wilson/claude',
                DATABASE_URL: 'postgres://board',
                PATH: '/wilson/bin',
            },
            own,
        );

        expect(env).toEqual({
            CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
            CLAUDE_AGENT_SDK_VERSION: '0.3.241',
            CLAUDE_CODE_OAUTH_TOKEN: 'worker-engine',
            PATH: '/worker/bin',
            HOME: '/home/worker',
        });
    });

    it('never forwards a token Wilson sent, even when the worker has none of its own', () => {
        expect(engineEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: 'from-wilson' }, {})).toEqual({});
    });
});
