import { Injectable } from 'injectkit';
// Card 0149: a value import, not `import type` — this class is now registered in the DI container
// (`BoardModule.setup`), and `@Injectable()`'s emitted `design:paramtypes` metadata can only name a
// class it can reference as a value. A type-only import erases at compile time, so the constructor's
// `Kysely<DB>` parameter would reflect as `Object` instead — exactly the shape of "Missing
// dependencies for ProjectRepository: Object" this avoids. Harmless for this class's other, pre-0149
// caller (`BoardModule`'s own `resolveProjectRow`, which constructs it directly with `new`, never
// through the container) since a value import still erases to nothing extra at runtime beyond the
// class reference itself.
import { Kysely } from 'kysely';
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

    /**
     * Every registered project's row, name ascending.
     *
     * Card 0149's one caller of this: the poller ticks every registered project rather than just the
     * one its own environment named, and needs the full set to walk. `BoardModule.setup`'s
     * `resolveProjectRow` still uses `find`/`create` directly (it runs before the container exists —
     * see this class's own doc comment), so this is additive, not a replacement for either.
     */
    async list(): Promise<ProjectRow[]> {
        return this.db.selectFrom('runner.projects').select(['name', 'boardRoot', 'codeRoot', 'worktreeRoot', 'runRoot']).orderBy('name').execute();
    }

    /** Create a project's row. Fails if the name is already taken. */
    async create(row: ProjectRow): Promise<void> {
        await this.db.insertInto('runner.projects').values(row).execute();
    }

    /**
     * Set whichever of the four path columns `patch` names, for the named project, leaving the
     * others untouched. Returns whether a row matched `name`, so the caller can answer 404 rather
     * than succeeding silently against nothing.
     *
     * An empty `patch` (every field absent, a valid `PATCH` body under the contract's own semantics)
     * is short-circuited to a `find` rather than reaching `set()`: Kysely compiles `set({})` to
     * `update ... set  where ...`, a SET clause with nothing in it, which Postgres rejects as a
     * syntax error rather than a no-op.
     */
    async update(name: string, patch: Partial<Omit<ProjectRow, 'name'>>): Promise<boolean> {
        if (Object.keys(patch).length === 0) {
            return (await this.find(name)) !== undefined;
        }
        const result = await this.db.updateTable('runner.projects').set(patch).where('name', '=', name).executeTakeFirst();
        return result.numUpdatedRows > 0n;
    }
}
