import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'injectkit';
import { Kysely } from 'kysely';
import { PasswordFactorService } from '@maroonedsoftware/authentication';
import { ServerKitServerBuilder } from '@maroonedsoftware/koa';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { AccountRepository } from '#modules/authentication/account.repository.js';
import { OnboardingService } from '#modules/authentication/onboarding.service.js';
import type { DB } from '#modules/data/db.js';
import { modules } from '#modules/modules.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { buildTestServerConfig } from '#tests/support/test.config.js';

/** Long and random enough for zxcvbn, which the password policy runs. */
const STRONG_PASSWORD = 'correct horse battery staple 47';

let container: Container;
let db: Kysely<DB>;
let release: () => Promise<void>;
beforeAll(async () => {
    release = await holdAccounts();
    container = await new ServerKitServerBuilder().setup(await buildTestServerConfig(), new ConsoleLogger(), modules);
    db = container.get(Kysely<DB>);
});
afterAll(async () => {
    await clearAccounts(db);
    await db.destroy();
    await release();
});
beforeEach(async () => {
    await clearAccounts(db);
});

/** Through the app's own container, so the wiring (policy, hash provider, limiter) is what runs. */
const onboarding = () => container.get(OnboardingService);

describe('OnboardingService', () => {
    it('reports no account before onboarding', async () => {
        expect(await onboarding().status()).toEqual({ requirements: [expect.objectContaining({ key: 'account', optional: false })] });
    });

    it('creates the account with a password that then verifies', async () => {
        expect(await onboarding().createAccount({ email: 'operator@example.com', password: STRONG_PASSWORD })).toEqual({ requirements: [] });

        const account = await container.get(AccountRepository).findByEmail('operator@example.com');
        expect(account).toMatchObject({ email: 'operator@example.com', active: true });
        await expect(container.get(PasswordFactorService).verifyPassword(account!.id, STRONG_PASSWORD)).resolves.toMatchObject({
            actorId: account!.id,
        });
    });

    it('stores the password hashed, never as typed', async () => {
        await onboarding().createAccount({ email: 'operator@example.com', password: STRONG_PASSWORD });

        const row = await db.selectFrom('wilson.accountPasswords').select('hash').executeTakeFirstOrThrow();
        expect(row.hash).not.toContain(STRONG_PASSWORD);
        expect(row.hash).toMatch(/^\$argon2id\$/);
    });

    it('trims the email and matches it without regard to case', async () => {
        await onboarding().createAccount({ email: '  Operator@Example.com ', password: STRONG_PASSWORD });

        expect(await container.get(AccountRepository).findByEmail('OPERATOR@EXAMPLE.COM')).toMatchObject({ email: 'Operator@Example.com' });
    });

    it('refuses a second account with 409', async () => {
        await onboarding().createAccount({ email: 'operator@example.com', password: STRONG_PASSWORD });

        await expect(onboarding().createAccount({ email: 'someone-else@example.com', password: STRONG_PASSWORD })).rejects.toMatchObject({
            statusCode: 409,
        });
    });

    /** The check before the transaction is only a fast path; the database is what holds the line. */
    it('lets exactly one of two concurrent onboardings through', async () => {
        const results = await Promise.allSettled([
            onboarding().createAccount({ email: 'first@example.com', password: STRONG_PASSWORD }),
            onboarding().createAccount({ email: 'second@example.com', password: STRONG_PASSWORD }),
        ]);

        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.statusCode)).toEqual([409]);
        expect(await db.selectFrom('wilson.accounts').select('id').execute()).toHaveLength(1);
    });

    it('refuses a weak password with 400 and leaves no account behind', async () => {
        await expect(onboarding().createAccount({ email: 'operator@example.com', password: 'password' })).rejects.toMatchObject({ statusCode: 400 });

        expect(await onboarding().status()).toEqual({ requirements: [expect.objectContaining({ key: 'account', optional: false })] });
    });

    it('refuses something that is not an email address with 400', async () => {
        await expect(onboarding().createAccount({ email: 'operator', password: STRONG_PASSWORD })).rejects.toMatchObject({ statusCode: 400 });
    });
});
