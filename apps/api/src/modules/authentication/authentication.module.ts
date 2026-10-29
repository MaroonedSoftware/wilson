import { Registry } from 'injectkit';
import { Kysely } from 'kysely';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import {
    ApiKeyAuthenticationHandler,
    ApiKeyRepository,
    ApiKeyService,
    ApiKeyServiceOptions,
    Argon2idPasswordHashProvider,
    AuthenticationHandlerChain,
    AuthenticationHandlerMap,
    AuthenticationSchemeHandler,
    AuthenticationSessionService,
    AuthenticationSessionServiceOptions,
    ChainedAuthenticationHandler,
    JwtAuthenticationHandler,
    JwtAuthenticationIssuerMap,
    JwtProvider,
    PasswordFactorRepository,
    PasswordFactorService,
    PasswordHashProvider,
    PasswordStrengthProvider,
} from '@maroonedsoftware/authentication';
import { CacheProvider } from '@maroonedsoftware/cache';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { PolicyService } from '@maroonedsoftware/policies';
import type { DB } from '#modules/data/db.js';
import { AccountRepository } from './account.repository.js';
import { AccountApiKeyRepository } from './api.key.repository.js';
import { ApiKeysService } from './api.keys.service.js';
import { CurrentSessionService } from './current.session.service.js';
import { OnboardingService } from './onboarding.service.js';
import { PasswordFactors, PasswordRateLimiter } from './password.factors.js';
import { AccountPasswordRepository } from './password.factor.repository.js';
import { WilsonJwtAuthenticationIssuer } from './session.issuer.js';
import { resolveSessionKey } from './session.key.js';
import { API_KEY_PREFIX, API_KEY_USE_WINDOW, SESSION_ISSUER, SESSION_LIFETIME } from './session.options.js';
import { TokenService } from './token.service.js';

export { API_KEY_PREFIX, API_KEY_USE_WINDOW, SESSION_ISSUER, SESSION_LIFETIME } from './session.options.js';

/**
 * PROJECT.md, Authentication. Sessions, the operator account and its password, and resolving a
 * bearer token into a session. Nothing here is enforced: `authenticationMiddleware` attaches the
 * caller's session to the request and refuses nobody, and rollout step 6 is what makes a route
 * require one.
 *
 * Sessions are stored through `CacheProvider`, which `SourcesModule` binds to `PostgresCacheProvider`,
 * so a session is a `runner.cache_entries` row and the per-subject session index is
 * `runner.cache_set_members` rows. Listed after Sources in `modules.ts` for that reason, though, as
 * every ordering note there says, `setup` only registers tokens.
 *
 * `AuthenticationSessionService` and `PasswordFactorService` are factories, not `useClass`: each
 * takes an optional trailing `AuditRecorder` that wilson does not bind yet, and a factory says which
 * arguments it gets instead of leaving injectkit to resolve one nobody registered.
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

        // How `authenticationMiddleware` turns `Authorization: Bearer <token>` into a session. One
        // `bearer` scheme with two credentials behind it, tried in turn by the chain, first session
        // that is not the sentinel winning: an API key (`wl_...`), then a session JWT. The key
        // handler goes first because its test is a string prefix and costs nothing, so a JWT is
        // declined without a query; the other way round, every key would be decoded as a JWT
        // first. deadair's order, for deadair's reason.
        registry.register(ApiKeyServiceOptions).useValue(new ApiKeyServiceOptions(API_KEY_PREFIX, 32, undefined, undefined, API_KEY_USE_WINDOW));
        registry.register(ApiKeyRepository).useClass(AccountApiKeyRepository).asTransient();
        registry
            .register(ApiKeyService)
            .useFactory(
                container =>
                    new ApiKeyService(
                        container.get(ApiKeyServiceOptions),
                        container.get(ApiKeyRepository),
                        container.get(CacheProvider),
                        container.get(PolicyService),
                        container.get(Logger),
                    ),
            )
            .asTransient();
        registry.register(ApiKeyAuthenticationHandler).useClass(ApiKeyAuthenticationHandler).asTransient();

        registry.register(WilsonJwtAuthenticationIssuer).useClass(WilsonJwtAuthenticationIssuer).asTransient();
        registry.register(JwtAuthenticationIssuerMap).useMap(JwtAuthenticationIssuerMap).set(SESSION_ISSUER, WilsonJwtAuthenticationIssuer);
        registry.register(JwtAuthenticationHandler).useClass(JwtAuthenticationHandler).asTransient();

        registry
            .register(AuthenticationHandlerChain)
            .useArray(AuthenticationHandlerChain)
            .push(ApiKeyAuthenticationHandler)
            .push(JwtAuthenticationHandler);
        registry.register(ChainedAuthenticationHandler).useClass(ChainedAuthenticationHandler).asTransient();
        registry.register(AuthenticationHandlerMap).useMap(AuthenticationHandlerMap).set('bearer', ChainedAuthenticationHandler);
        registry.register(AuthenticationSchemeHandler).useClass(AuthenticationSchemeHandler).asTransient();

        registry.register(TokenService).useClass(TokenService).asTransient();
        registry.register(CurrentSessionService).useClass(CurrentSessionService).asTransient();
        registry.register(ApiKeysService).useClass(ApiKeysService).asTransient();

        registry.register(AccountRepository).useClass(AccountRepository).asTransient();
        registry.register(OnboardingService).useClass(OnboardingService).asTransient();

        // Singletons: the strength checker loads zxcvbn's dictionaries once, and the limiter's
        // count has to survive from one request to the next.
        registry.register(PasswordStrengthProvider).useClass(PasswordStrengthProvider).asSingleton();
        registry.register(PasswordHashProvider).useClass(Argon2idPasswordHashProvider).asSingleton();
        registry.register(PasswordRateLimiter).useClass(PasswordRateLimiter).asSingleton();
        registry.register(PasswordFactorRepository).useClass(AccountPasswordRepository).asTransient();
        registry.register(PasswordFactors).useClass(PasswordFactors).asTransient();
        registry
            .register(PasswordFactorService)
            .useFactory(container => container.get(PasswordFactors).over(container.get(Kysely<DB>)))
            .asTransient();
    },
};
