import { Injectable } from 'injectkit';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

/** A project's identity, as read from or written to `runner.projects`. */
export interface ProjectRow {
    name: string;
    boardRoot: string;
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
}

/**
 * `runner.projects`, in Postgres — a project's name and the four paths `BoardConfig` exposes.
 *
 * Follows `postgres.board.repository.ts`'s shape, but is not registered in the DI registry the way
 * that class is: its one caller, `BoardModule.setup`, runs before the container exists — `setup`
 * only receives a `Registry`, and the container is built only after every module's `setup` has run
 * (see `ServerKitModule`'s doc comment) — so there is nothing for a `Kysely<DB>` constructor
 * parameter to resolve against yet. `BoardModule` builds this class directly, against a short-lived
 * connection of its own, instead of injecting it.
 */
@Injectable()
export class ProjectRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** The named project's row, or undefined if it has never been created. */
    async find(name: string): Promise<ProjectRow | undefined> {
        return this.db
            .selectFrom('runner.projects')
            .select(['name', 'boardRoot', 'codeRoot', 'worktreeRoot', 'runRoot'])
            .where('name', '=', name)
            .executeTakeFirst();
    }

    /** Create a project's row. Fails if the name is already taken. */
    async create(row: ProjectRow): Promise<void> {
        await this.db.insertInto('runner.projects').values(row).execute();
    }
}
