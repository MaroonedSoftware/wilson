import { sql, type Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

/**
 * Stands up `runner.settings` on the shared tmpfs test database for a test run.
 *
 * `pnpm migrate:up` is not on this stage's allowlist (card 0106), so the table the real migration
 * (`apps/api/data/migrations/20260826120000_settings.sql`) creates does not exist there yet.
 * `IF NOT EXISTS` mirrors `card.jobs.test.ts`'s identical workaround for `pgboss.job`: safe to call
 * from every settings test file's `beforeAll`, even when several run against the same connection or
 * the table was already created by an earlier suite in this process.
 */
export const ensureSettingsTable = (db: Kysely<DB>): Promise<unknown> =>
    sql`
        create table if not exists runner.settings (
            project text not null,
            key text not null,
            value jsonb not null,
            updated_at timestamptz not null default now(),
            primary key (project, key)
        )
    `.execute(db);
