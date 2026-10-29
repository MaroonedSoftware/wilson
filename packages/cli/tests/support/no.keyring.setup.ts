import { vi } from 'vitest';

/**
 * No test reaches the developer's real keychain. `apiClient` reads this machine's API key from the
 * OS keyring on its first request (`credentials.ts`), and a command test that let it would read, or
 * block on an access prompt for, whatever `wilson auth login` stored for real. `keyStoreFor` is the
 * one place the keyring is opened, so every suite gets an always-empty store there instead. Tests of
 * the credential code itself inject their own in-memory store.
 *
 * Mocked by the module's absolute path rather than a package specifier, so it is the same module
 * whichever package's tests load it (`apps/api`'s tests/cli import this package's source too).
 *
 * Both packages must also link the same copy of johnny5, or `apps/api`'s tests that mock
 * `@maroonedsoftware/johnny5`'s prompts would mock a copy the commands do not import, and a real
 * prompt would wait on stdin. pnpm keys a copy by its resolved peers, so `@napi-rs/keyring` (a
 * johnny5 peer) is a dependency of both.
 */
vi.mock(new URL('../../src/credentials.ts', import.meta.url).pathname, async importOriginal => {
    const actual = await importOriginal<typeof import('../../src/credentials.js')>();
    return {
        ...actual,
        keyStoreFor: () => ({ read: async () => undefined, write: async () => false, clear: async () => true }),
    };
});
