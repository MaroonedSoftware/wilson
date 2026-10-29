import { z } from 'zod';

/**
 * Whether onboarding has happened. The web app asks this to choose between the onboarding page and
 * the sign-in page; it says nothing else about the account.
 * generated from [OnboardingStatus](../../data/contracts/onboarding.ck)
 */
export const OnboardingStatus = z.strictObject({
    accountExists: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;

/**
 * The operator account. A username rather than an email address, so signing in needs no mail setup.
 * `password` is checked for strength (zxcvbn, through the authentication library's password policy)
 * beyond the length limits here.
 * generated from [CreateAccountRequest](../../data/contracts/onboarding.ck)
 */
export const CreateAccountRequest = z.strictObject({
    username: z.string().min(1).max(64),
    password: z.string().min(8).max(256),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;
