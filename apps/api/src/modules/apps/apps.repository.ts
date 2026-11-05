import { Injectable } from 'injectkit';
import { Kysely, sql, type Selectable } from 'kysely';
import type { DB, WilsonApps } from '#modules/data/db.js';

/** A `wilson.apps` row. */
export type AppRow = Selectable<WilsonApps>;

/** What an install writes. */
export interface AppValues {
    slug: string;
    name: string;
    description: string;
    html: string;
    grants: string[];
    version: string | null;
    apiVersion: number;
}

const SUMMARY_COLUMNS = ['slug', 'name', 'description', 'grants', 'version', 'apiVersion', 'createdAt', 'updatedAt'] as const;

/** `wilson.apps`. Deployment-scoped, so nothing here reads the current project. */
@Injectable()
export class AppsRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Every app without its HTML, which a list has no use for and which can run to a megabyte each. */
    async list(): Promise<Omit<AppRow, 'html'>[]> {
        return this.db.selectFrom('wilson.apps').select(SUMMARY_COLUMNS).orderBy('name').orderBy('slug').execute();
    }

    async find(slug: string): Promise<AppRow | undefined> {
        return this.db.selectFrom('wilson.apps').selectAll().where('slug', '=', slug).executeTakeFirst();
    }

    /** Insert the app, or replace the one under this slug, which keeps its `createdAt`. */
    async upsert(values: AppValues): Promise<AppRow> {
        return this.db
            .insertInto('wilson.apps')
            .values(values)
            .onConflict(conflict =>
                conflict.column('slug').doUpdateSet({
                    name: values.name,
                    description: values.description,
                    html: values.html,
                    grants: values.grants,
                    version: values.version,
                    apiVersion: values.apiVersion,
                    updatedAt: sql`NOW()`,
                }),
            )
            .returningAll()
            .executeTakeFirstOrThrow();
    }

    /** Whether there was an app to delete. */
    async delete(slug: string): Promise<boolean> {
        const result = await this.db.deleteFrom('wilson.apps').where('slug', '=', slug).executeTakeFirst();
        return result.numDeletedRows > 0n;
    }
}
