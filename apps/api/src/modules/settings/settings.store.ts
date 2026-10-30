import { Injectable } from 'injectkit';
import type { Kysely } from 'kysely';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { BoardConfig } from '#modules/board/board.config.js';
import { optionalConfigString } from '#shared/require.config.js';
import type { DB } from '#modules/data/db.js';
import type { SettingDefinition } from './setting.definition.js';

/**
 * The `project` column value every deployment-scoped row is keyed by, in place of whichever
 * project happens to be current.
 *
 * Not a real project name: `wilson.projects.name` (and so every `BoardConfig.project`) comes from
 * `PROJECT_NAME` or a directory, never from this constant, and registering a project is out of
 * scope for card 0152 that introduced this — so there is nothing for it to collide with today.
 * Reserved here, once, so every reader and writer of a deployment-scoped row agrees on the exact
 * string.
 */
export const DEPLOYMENT_SCOPE = '__deployment__';

/**
 * Operational settings, resolved database row -> environment variable -> coded default.
 *
 * "Operational" is deliberate and narrow: policy an operator changes while the system runs, like
 * whether the poller is enqueueing. Secrets and deployment topology — `DATABASE_URL`, provider
 * keys, `PROJECT_*` roots — stay in the environment, where they are already managed and where
 * nothing here reaches. The one exception is the engine token, which an operator has to be able to
 * replace without recreating a container: it is stored encrypted, and only
 * `EngineTokenSettingService` reads or writes it.
 *
 * A fresh database has no rows, so `get` falls through to the environment variable exactly as it
 * always has, and from there to the coded default — a deploy that never touches `wilson.settings`
 * behaves identically to one that predates it.
 *
 * One row per `(project, key)`, keyed the same way every other operational table in this schema is
 * (`wilson.card_jobs` among them) — see the migration (`data/migrations/20261029000200_settings.sql`)
 * for the exact shape. Card 0152: `project` no longer always means "the current project's row".
 * `SettingDefinition.scope` says which a given key is; a `'project'` setting is still keyed by
 * `BoardConfig.project` exactly as every setting was before this, and a `'deployment'` setting is
 * keyed by the reserved {@link DEPLOYMENT_SCOPE} value instead, so the same row answers `get`
 * whichever project is current — see `scopeKey` below.
 */
@Injectable()
export class SettingsStore {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
        private readonly appConfig: AppConfig,
    ) {}

    /** Resolve one setting: a database row, else its environment variable, else its coded default. */
    async get<T>(definition: SettingDefinition<T>): Promise<T> {
        const row = await this.row(definition);
        if (row) return row.value as T;

        const raw = optionalConfigString(this.appConfig, definition.envVar);
        if (raw !== undefined) return definition.parseEnv(raw);

        return definition.defaultValue;
    }

    /** The database row's value alone, for a setting whose environment variable means something else. */
    async stored<T>(definition: SettingDefinition<T>): Promise<T | undefined> {
        return (await this.row(definition))?.value as T | undefined;
    }

    /** Persist a value, overriding the environment variable and the default from now on. */
    async set<T>(definition: SettingDefinition<T>, value: T): Promise<void> {
        const serialized = JSON.stringify(value);
        await this.db
            .insertInto('wilson.settings')
            .values({ project: this.scopeKey(definition), key: definition.key, value: serialized })
            .onConflict(oc => oc.columns(['project', 'key']).doUpdateSet({ value: serialized }))
            .execute();
    }

    /** Delete the row, so the environment variable and the default apply again. */
    async clear<T>(definition: SettingDefinition<T>): Promise<void> {
        await this.db.deleteFrom('wilson.settings').where('project', '=', this.scopeKey(definition)).where('key', '=', definition.key).execute();
    }

    private row<T>(definition: SettingDefinition<T>) {
        return this.db
            .selectFrom('wilson.settings')
            .select('value')
            .where('project', '=', this.scopeKey(definition))
            .where('key', '=', definition.key)
            .executeTakeFirst();
    }

    /**
     * The `project` column value a definition's row lives under: the current project for a
     * `'project'`-scoped setting (unchanged from before `scope` existed), or the reserved
     * {@link DEPLOYMENT_SCOPE} value for a `'deployment'`-scoped one, so the row is the same
     * regardless of which project is current when it is read or written.
     */
    private scopeKey(definition: SettingDefinition<unknown>): string {
        return definition.scope === 'deployment' ? DEPLOYMENT_SCOPE : this.config.project;
    }
}
