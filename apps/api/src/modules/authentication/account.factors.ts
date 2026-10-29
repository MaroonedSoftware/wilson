import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import type { DateTime } from 'luxon';
import type { AuthenticationFactorKind, AuthenticationFactorMethod } from '@maroonedsoftware/authentication';
import type { DB } from '#modules/data/db.js';

/** A second factor the operator has enrolled, as sign-in and the factor list describe it. */
export interface SecondFactor {
    method: AuthenticationFactorMethod;
    methodId: string;
    kind: AuthenticationFactorKind;
    label?: string;
    createdAt: DateTime;
}

/**
 * The methods that count as a strong factor: something the operator has, not something they know.
 * Once one is enrolled, signing in needs it, and so does a step-up (`StepUpPolicy`).
 */
export const STRONG_METHODS: readonly AuthenticationFactorMethod[] = ['authenticator', 'fido'];

/** The operator's enrolled second factors, across every kind wilson supports. */
@Injectable()
export class AccountFactors {
    constructor(private readonly db: Kysely<DB>) {}

    async list(accountId: string): Promise<SecondFactor[]> {
        const authenticators = await this.db
            .selectFrom('runner.accountAuthenticators')
            .select(['id', 'label', 'createdAt'])
            .where('accountId', '=', accountId)
            .where('active', '=', true)
            .orderBy('createdAt')
            .execute();
        const passkeys = await this.db
            .selectFrom('runner.accountPasskeys')
            .select(['id', 'label', 'createdAt'])
            .where('accountId', '=', accountId)
            .where('active', '=', true)
            .orderBy('createdAt')
            .execute();
        return [
            ...authenticators.map(row => ({ method: 'authenticator' as const, methodId: row.id, label: row.label, createdAt: row.createdAt })),
            ...passkeys.map(row => ({ method: 'fido' as const, methodId: row.id, label: row.label, createdAt: row.createdAt })),
        ].map(({ label, ...factor }) => ({ ...factor, kind: 'possession' as const, ...(label === null ? {} : { label }) }));
    }

    async hasStrongFactor(accountId: string): Promise<boolean> {
        return (await this.list(accountId)).length > 0;
    }
}
