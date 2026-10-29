import { configure } from '@testing-library/react';

// Card 0251: under the full suite's load (every package's tests running in parallel), a route
// load plus its query can take longer than Testing Library's default 1000ms `findBy*`/`waitFor`
// timeout. On 2026-09-19 this flaked apps/web/tests/project-switcher.test.ts against card 0250's
// merge check (and a different web test against card 0241's first testing attempt), even though
// the tests already wait correctly with `await screen.findByText(...)`. Raise the wait to 5s so
// tests stop failing on slowness; a genuinely broken test still fails, just 4 seconds later.
configure({ asyncUtilTimeout: 5000 });

// Every test starts signed in, so a test of the board or a card renders past `AuthGate` exactly as
// it did before the app required a session. Tests of signing in clear it themselves
// (`setAccessToken(undefined)`); `auth-gate.test.ts` is where that is exercised.
import { beforeEach } from 'vitest';
import { setAccessToken } from '#src/lib/session.js';

beforeEach(() => {
    setAccessToken('test-access-token');
});
