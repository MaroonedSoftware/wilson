/**
 * One thing first run still needs, after deadair's onboarding requirements. There is one today,
 * `account`: the operator account, which `POST /api/onboarding` creates. A list rather than a flag so
 * a later first-run step joins it without a new endpoint, and a client that does not know a key can
 * still name it (`title`) and say where to finish it.
 * generated from [OnboardingRequirement](../../../../apps/api/data/contracts/onboarding.ck)
 */
export interface OnboardingRequirement {
    key: 'account';
    title: string;
    description: string;
    /** Whether first run can be finished without it. */
    optional: boolean;
}

/**
 * The operator account. A username rather than an email address, so signing in needs no mail setup.
 * `password` is checked for strength (zxcvbn, through the authentication library's password policy)
 * beyond the length limits here.
 * generated from [CreateAccountRequest](../../../../apps/api/data/contracts/onboarding.ck)
 */
export interface CreateAccountRequest {
    username: string;
    password: string;
}

/**
 * What first run still needs, empty once onboarding is done. The web app asks this to choose
 * between the onboarding page and the sign-in page, and `wilson board init` to choose between
 * creating the account and signing in; it says nothing else about the account.
 * generated from [OnboardingStatus](../../../../apps/api/data/contracts/onboarding.ck)
 */
export interface OnboardingStatus {
    requirements: OnboardingRequirement[];
}
