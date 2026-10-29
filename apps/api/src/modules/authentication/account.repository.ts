import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

/** The operator account as the rest of the API sees it. */
export interface AccountRow {
    id: string;
    email: string;
    active: boolean;
}

/** `runner.accounts`. There is at most one row (see the migration), but nothing here assumes so. */
@Injectable()
export class AccountRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Whether onboarding has happened: any account at all, active or not. */
    async exists(): Promise<boolean> {
        const row = await this.db.selectFrom('runner.accounts').select('id').limit(1).executeTakeFirst();
        return row !== undefined;
    }

    /** The account signing in as `email`, matched without regard to case. */
    async findByEmail(email: string): Promise<AccountRow | undefined> {
        return this.db
            .selectFrom('runner.accounts')
            .select(['id', 'email', 'active'])
            .where(eb => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
            .executeTakeFirst();
    }

    async get(id: string): Promise<AccountRow | undefined> {
        return this.db.selectFrom('runner.accounts').select(['id', 'email', 'active']).where('id', '=', id).executeTakeFirst();
    }

    /** Whether `id` names an account that may still sign in. */
    async existsActive(id: string): Promise<boolean> {
        const row = await this.db.selectFrom('runner.accounts').select('id').where('id', '=', id).where('active', '=', true).executeTakeFirst();
        return row !== undefined;
    }

    /** Inserts the account. A second one fails on `accounts_one_row` with a unique violation. */
    async create(email: string): Promise<AccountRow> {
        return this.db.insertInto('runner.accounts').values({ email }).returning(['id', 'email', 'active']).executeTakeFirstOrThrow();
    }
}
