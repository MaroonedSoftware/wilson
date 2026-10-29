import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import { httpError } from '@maroonedsoftware/errors';
import type { DB } from '#modules/data/db.js';
import type { CreateAccountRequest, OnboardingRequirement, OnboardingStatus } from '../../generated/onboarding.js';
import { AccountRepository } from './account.repository.js';
import { PasswordFactors } from './password.factors.js';

/** One `@`, with something either side of it and no whitespace. */
const LOOKS_LIKE_EMAIL = /^[^@\s]+@[^@\s]+$/;

/** Postgres's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string } | undefined)?.code === UNIQUE_VIOLATION;

const ACCOUNT: OnboardingRequirement = {
    key: 'account',
    title: 'Operator account',
    description: 'Create the one account that signs in to Wilson',
    optional: false,
};

const alreadyOnboarded = () => httpError(409).withDetails({ reason: 'an account already exists; sign in instead' });

/**
 * First-run onboarding: creating the operator account (PROJECT.md, Authentication). Unauthenticated
 * by necessity, since there is nobody to authenticate yet, so "no account exists" is the only thing
 * standing between a caller and the account. The database holds that line: `accounts_one_row`
 * admits one row, so of two racing requests one inserts and the other gets a unique violation,
 * which is answered 409 here. The check before the transaction is only there to refuse the common
 * case without hashing a password first.
 */
@Injectable()
export class OnboardingService {
    constructor(
        private readonly db: Kysely<DB>,
        private readonly accounts: AccountRepository,
        private readonly passwords: PasswordFactors,
    ) {}

    /**
     * What first run still needs, as a list after deadair's onboarding requirements, so a later
     * first-run step joins it rather than adding a field every client has to learn. Today the only
     * one is the account.
     */
    async status(): Promise<OnboardingStatus> {
        const requirements: OnboardingRequirement[] = [];
        if (!(await this.accounts.exists())) requirements.push(ACCOUNT);
        return { requirements };
    }

    /**
     * Creates the account and its password in one transaction, so a password the policy refuses
     * (400, too weak) leaves no account behind it and onboarding can be tried again.
     */
    async createAccount(request: CreateAccountRequest): Promise<OnboardingStatus> {
        // The contract checks the format at the route; this is for a caller that skips it.
        const email = request.email.trim();
        if (!LOOKS_LIKE_EMAIL.test(email)) {
            throw httpError(400).withDetails({ reason: 'that is not an email address' });
        }
        if (await this.accounts.exists()) throw alreadyOnboarded();

        try {
            await this.db.transaction().execute(async trx => {
                const account = await new AccountRepository(trx).create(email);
                await this.passwords.over(trx).createPasswordFactor(account.id, request.password);
            });
        } catch (err) {
            if (isUniqueViolation(err)) throw alreadyOnboarded();
            throw err;
        }
        return this.status();
    }
}
