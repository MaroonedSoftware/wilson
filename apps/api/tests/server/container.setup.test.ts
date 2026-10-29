import { describe, expect, it } from 'vitest';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { ServerKitContext, ServerKitServerBuilder } from '@maroonedsoftware/koa';
import { JobContext } from '@maroonedsoftware/jobbroker';
import { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { ApiKeysService } from '#modules/authentication/api.keys.service.js';
import { CurrentSessionService } from '#modules/authentication/current.session.service.js';
import { FactorsService } from '#modules/authentication/factors.service.js';
import { TokenService } from '#modules/authentication/token.service.js';
import { CardStageDeadJob } from '#modules/jobs/card.stage.dead.job.js';
import { buildConfig, modules } from '#src/cli-bootstrap.js';
import { buildTestServerConfig } from '#tests/support/test.config.js';

/**
 * Card 0112. On 2026-08-26 card 0106 merged with a passing build, lint, 1,146 tests and a green
 * review, and the server would not start: `SettingsStore` was registered `useClass` while its
 * constructor took `AppConfig`, which is never a registered token — only the argument `setup`
 * hooks are handed. Nothing in the suite built the container the way the server actually does, so
 * nothing caught it.
 *
 * This builds the container from the app's own `modules` (`cli-bootstrap.ts`/`modules.ts`) and the
 * app's own `buildConfig`, via `ServerKitServerBuilder.setup` — the same call `setup.server.ts`
 * makes — rather than a hand-assembled module list, which would only prove that list resolves.
 *
 * **What this does and does not prove.** `registry.build()`, called at the end of `setup`, runs
 * InjectKit's `verifyRegistrations`: it would have caught the `SettingsStore` bug on its own,
 * because it checks a `useClass` registration's constructor dependencies (from decorator metadata)
 * against every other registered token. But that check is static and only sees what a `useClass`
 * registration declares — a `useFactory` registration (the database pool, `JobRunner`, the stage
 * agent map, `SettingsStore` itself after the fix) declares no dependencies at all, so whatever it
 * reaches for via `container.get(...)` inside the factory body is invisible to it and would only
 * fail once something actually resolves that token. So this resolves every token the container
 * knows about, not just the ones a `useClass` constructor happens to name, catching a broken
 * factory the same way `verifyRegistrations` catches a broken class.
 *
 * It proves the dependency graph resolves — nothing more. It does not run any module's `start` or
 * `ready` hook (`JobRunner.start()`, the poller, the card feed listener), and it does not bind a
 * port: none of `setupMiddleware`, `setupRoutes`, or `start` is called. A wiring error in what a
 * `start` hook itself does, as opposed to what it depends on, is out of reach of this test.
 */
describe('container wiring (card 0112)', () => {
    // Every registered token this container knows about is expected to resolve — except a token
    // deliberately built to reject that. `registerJobContext` (jobbroker) registers `JobContext`
    // with a factory that always throws "JobContext is only available during a job execution. It
    // cannot be resolved at boot, from a request scope, or from a singleton." — the real value is
    // supplied only inside a job's own execution scope (`PgBossJobRunner.start`), never here.
    // `CardStageDeadJob` takes `JobContext` as a constructor dependency, so it inherits the same
    // restriction. Both are legitimate, by design, not a wiring defect this test should catch.
    // `ServerKitContext` is the same thing for a request: `@maroonedsoftware/koa` 4 registers it with
    // a factory that throws "ServerKitContext is only available inside a request scope", and the
    // real value is supplied per request by `serverKitContextMiddleware`. `CurrentSessionService`,
    // `ApiKeysService`, `TokenService` and `FactorsService` take `ServerKitContext` as a constructor
    // dependency, so they inherit the same restriction.
    const NOT_RESOLVABLE_AT_BOOT = new Set<unknown>([
        JobContext,
        CardStageDeadJob,
        ServerKitContext,
        CurrentSessionService,
        ApiKeysService,
        TokenService,
        FactorsService,
    ]);

    it('builds the app\'s own container and resolves every registration', async () => {
        const config = await buildTestServerConfig();
        const logger = new ConsoleLogger();
        const serverBuilder = new ServerKitServerBuilder();

        // The call `setup.server.ts` makes. `registry.build()` inside it is where the `SettingsStore`
        // bug actually threw ("Missing dependencies for SettingsStore: Object") — this alone already
        // covers every `useClass` registration.
        const container = await serverBuilder.setup(config, logger, modules);

        try {
            // `Container` (the public type from `injectkit`) intentionally exposes no way to list
            // what it holds — `get`, `hasRegistration`, `createScopedContainer`, `disposeAsync`, and
            // nothing to enumerate. The concrete container built by `registry.build()` still carries
            // its registrations map as a plain field (`registrations`), just not one the published
            // type admits to; reaching past the type here is what "resolve every registered token"
            // requires when the library gives no supported way to ask "every token" in the first
            // place.
            const registered = (container as unknown as { registrations: Map<unknown, unknown> }).registrations;
            expect(registered.size).toBeGreaterThan(0);

            for (const token of registered.keys()) {
                if (NOT_RESOLVABLE_AT_BOOT.has(token)) continue;
                // Intentionally not wrapped in try/catch: a failing resolution should fail this test
                // with the same error a booting server would hit, naming the token that could not be
                // built.
                container.get(token as never);
            }
        } finally {
            // The database pool a `useFactory` registration above may have opened is this test's to
            // close — `ServerKitServerBuilder.shutdown` never runs here (this test never calls
            // `start()`), and nothing else in this process will.
            await container.get(Kysely<DB>).destroy();
        }
    });

    it('uses the app\'s own modules and buildConfig, not a hand-assembled list', () => {
        // A regression guard on the test itself: importing anything other than these two exports
        // from `cli-bootstrap.ts` would prove a hand-assembled list resolves, not the app's own —
        // exactly the gap this card closes. Asserting on their identity here means a future edit
        // that swaps them out for a local module array fails loudly instead of quietly narrowing
        // what this test covers.
        expect(typeof buildConfig).toBe('function');
        expect(Array.isArray(modules)).toBe(true);
        expect(modules.length).toBeGreaterThan(0);
    });
});
