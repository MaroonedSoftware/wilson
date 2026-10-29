import { z } from 'zod';

/**
 * One thing first run still needs, after deadair's onboarding requirements. There is one today,
 * `account`: the operator account, which `POST /api/onboarding` creates. A list rather than a flag so
 * a later first-run step joins it without a new endpoint, and a client that does not know a key can
 * still name it (`title`) and say where to finish it.
 * generated from [OnboardingRequirement](../../data/contracts/onboarding.ck)
 */
export const OnboardingRequirement = z.strictObject({
    key: z.enum(['account']),
    title: z.string(),
    description: z.string(),
    optional: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .describe('Whether first run can be finished without it.'),
});
export type OnboardingRequirement = z.infer<typeof OnboardingRequirement>;

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

/**
 * What first run still needs, empty once onboarding is done. The web app asks this to choose
 * between the onboarding page and the sign-in page, and `wilson board init` to choose between
 * creating the account and signing in; it says nothing else about the account.
 * generated from [OnboardingStatus](../../data/contracts/onboarding.ck)
 */
export const OnboardingStatus = z.strictObject({
    requirements: z.array(OnboardingRequirement),
});
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;
