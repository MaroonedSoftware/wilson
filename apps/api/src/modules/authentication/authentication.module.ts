import { Registry } from 'injectkit';
import { Duration } from 'luxon';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { AuthenticationSessionService, AuthenticationSessionServiceOptions, JwtProvider } from '@maroonedsoftware/authentication';
import { CacheProvider } from '@maroonedsoftware/cache';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { resolveSessionKey } from './session.key.js';

/** The `iss` and `aud` of every session token, so a token minted by another ServerKit app (deadair,
 * ats) that happened to share a key would still be refused here. */
export const SESSION_ISSUER = 'wilson';

/** How long a session lives, and so how long an access token naming it does: deadair's thirty days.
 * Revocation does not wait for it, since every token is checked against its session on use. */
export const SESSION_LIFETIME = Duration.fromObject({ days: 30 });

/**
 * PROJECT.md, Authentication, rollout step 2: the session machinery, with nothing yet calling it.
 * No route mints a session and no middleware reads one; that is steps 3 and 6.
 *
 * Sessions are stored through `CacheProvider`, which `SourcesModule` binds to `PostgresCacheProvider`,
 * so a session is a `runner.cache_entries` row and the per-subject session index is
 * `runner.cache_set_members` rows. Listed after Sources in `modules.ts` for that reason, though, as
 * every ordering note there says, `setup` only registers tokens.
 *
 * Factories rather than `useClass` throughout. `AuthenticationSessionService` takes an optional
 * trailing `AuditRecorder` that this step does not bind, and a factory says which arguments it gets
 * instead of leaving injectkit to resolve one nobody registered.
 */
export const AuthenticationModule: ServerKitModule = {
    name: 'Authentication',
    setup: async (registry: Registry, config: AppConfig) => {
        // Resolved once, at setup, so a missing or unreadable key file fails the boot that needed
        // it, naming the file, rather than the first sign-in.
        const sessionKey = await resolveSessionKey(config);

        registry
            .register(JwtProvider)
            .useFactory(container => new JwtProvider(container.get(Logger), sessionKey))
            .asSingleton();
        registry
            .register(AuthenticationSessionServiceOptions)
            .useValue(new AuthenticationSessionServiceOptions(SESSION_ISSUER, SESSION_ISSUER, SESSION_LIFETIME));
        registry
            .register(AuthenticationSessionService)
            .useFactory(
                container =>
                    new AuthenticationSessionService(
                        container.get(AuthenticationSessionServiceOptions),
                        container.get(CacheProvider),
                        container.get(JwtProvider),
                    ),
            )
            .asTransient();
    },
};
