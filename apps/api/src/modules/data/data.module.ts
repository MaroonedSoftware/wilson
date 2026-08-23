import { Container, Registry } from 'injectkit';
import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import type { DB } from './db.js';
import { configNumber, requireConfigString } from '#shared/require.config.js';

/**
 * The database.
 *
 * Deliberately thinner than the equivalent module in a multi-tenant app: this system is
 * single-operator (PROJECT.md non-goals), so there is no RLS, no audit context, and no per-request
 * transaction scoping. One pool, registered as a singleton, injected wherever it is needed.
 */
export const DataModule: ServerKitModule = {
    name: 'Data',
    setup: async (registry: Registry, config: AppConfig) => {
        const dbConfig = {
            host: requireConfigString(config, 'DATABASE_HOST'),
            port: configNumber(config, 'DATABASE_PORT', 5432),
            user: requireConfigString(config, 'DATABASE_USER'),
            password: requireConfigString(config, 'DATABASE_PASSWORD'),
            database: requireConfigString(config, 'DATABASE_NAME'),
            types: KyselyPgTypeOverrides,
        };

        registry
            .register(KyselyPool)
            .useFactory(container => {
                const pool = new KyselyPool(dbConfig);
                const logger = container.get(Logger);
                // A pool-level error has no caller to reject; without this handler an idle-client
                // failure takes the process down as an unhandled 'error' event.
                pool.on('error', err => logger.error(err));
                return pool;
            })
            .asSingleton();

        registry
            .register(Kysely<DB>)
            .useFactory(container => {
                const logger = container.get(Logger);
                return new Kysely<DB>({
                    dialect: new PostgresDialect({ pool: container.get(KyselyPool) }),
                    plugins: [...KyselyDefaultPlugins],
                    log: (event: LogEvent) => {
                        if (event.level === 'error') {
                            logger.error(event.error);
                        }
                    },
                });
            })
            .asSingleton();
    },
    // Registered first, so it tears down last: everything that might still be writing an event has
    // already shut down by the time the pool closes.
    shutdown: async (container: Container) => {
        await container.get(Kysely<DB>).destroy();
    },
};
