/**
 * Whether onboarding has happened. The web app asks this to choose between the onboarding page and
 * the sign-in page; it says nothing else about the account.
 * generated from [OnboardingStatus](file://./../../../../apps/api/data/contracts/onboarding.ck#L16)
 */
export interface OnboardingStatus {
    accountExists: boolean;
}

/**
 * The operator account. A username rather than an email address, so signing in needs no mail setup.
 * `password` is checked for strength (zxcvbn, through the authentication library's password policy)
 * beyond the length limits here.
 * generated from [CreateAccountRequest](file://./../../../../apps/api/data/contracts/onboarding.ck#L23)
 */
export interface CreateAccountRequest {
    username: string;
    password: string;
}
