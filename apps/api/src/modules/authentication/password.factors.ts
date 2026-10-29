import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { PasswordFactorService, PasswordHashProvider, PasswordStrengthProvider } from '@maroonedsoftware/authentication';
import { CacheProvider } from '@maroonedsoftware/cache';
import { PolicyService } from '@maroonedsoftware/policies';
import type { DB } from '#modules/data/db.js';
import { AccountPasswordRepository } from './password.factor.repository.js';

/**
 * Five wrong passwords in thirty seconds block that account for five minutes: deadair's numbers.
 *
 * In memory, where deadair's is in Redis. Wilson has no Redis, and only the API process verifies a
 * password (the CLI signs in through it), so one process's memory is the whole of it. A restart
 * forgets the count, which costs an attacker a restart they cannot cause. With one account, the
 * same five tries also let anyone who can reach the API lock the operator out for five minutes;
 * that is the trade every lockout makes, and the API is not meant to be reachable by strangers.
 */
@Injectable()
export class PasswordRateLimiter extends RateLimiterMemory {
    constructor() {
        super({ keyPrefix: 'password', points: 5, duration: 30, blockDuration: 300 });
    }
}

/**
 * Builds `PasswordFactorService` over a given database handle, so onboarding can create an account
 * and its password in one transaction: the library's service takes its repository at construction,
 * and the container's is bound to the pool, outside any transaction.
 */
@Injectable()
export class PasswordFactors {
    constructor(
        private readonly limiter: PasswordRateLimiter,
        private readonly strength: PasswordStrengthProvider,
        private readonly hashes: PasswordHashProvider,
        private readonly policies: PolicyService,
        private readonly cache: CacheProvider,
    ) {}

    over(db: Kysely<DB>): PasswordFactorService {
        return new PasswordFactorService(new AccountPasswordRepository(db), this.limiter, this.strength, this.hashes, this.policies, this.cache);
    }
}
