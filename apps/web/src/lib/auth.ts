import { SdkError } from '@wilson/sdk';
import { API_BASE, wilson } from './sdk.js';
import { currentAccessToken, refreshSession, setAccessToken } from './session.js';

/** Where the app stands before it can show a board. */
export type SessionState = 'checking' | 'onboarding' | 'signed-out' | 'signed-in';

/**
 * On load: no account yet means onboarding; otherwise try the refresh cookie, which signs a
 * returning operator straight back in. An access token already in memory needs neither.
 */
export const restoreSession = async (): Promise<SessionState> => {
    if (currentAccessToken()) return 'signed-in';
    const { accountExists } = await wilson.onboarding.getOnboardingStatus();
    if (!accountExists) return 'onboarding';
    return (await refreshSession(API_BASE)) ? 'signed-in' : 'signed-out';
};

/** Why a sign-in failed, in the operator's words. */
export const signInFailure = (err: unknown): string => {
    if (err instanceof SdkError && err.status === 401) return 'Wrong username or password.';
    if (err instanceof SdkError && err.status === 429) return 'Too many wrong passwords. Wait five minutes and try again.';
    return 'Could not reach the API.';
};

/**
 * Why onboarding failed. The password policy's refusal carries zxcvbn's warning and suggestions in
 * `details.password` and `details.suggestions`, not the `details.reason` other refusals use.
 */
export const onboardingFailure = (err: unknown): string => {
    if (err instanceof SdkError) {
        const details = (err.body as { details?: { reason?: string; password?: string; suggestions?: string[] } } | undefined)?.details;
        if (err.status === 409) return 'An account already exists. Reload the page to sign in.';
        if (details?.password !== undefined || details?.suggestions) {
            const advice = [details.password, ...(details.suggestions ?? [])].filter(Boolean).join(' ');
            return `That password is too easy to guess.${advice ? ` ${advice}` : ''}`;
        }
        if (details?.reason) return details.reason;
    }
    return 'Could not reach the API.';
};

export const signIn = async (username: string, password: string): Promise<void> => {
    const { accessToken } = await wilson.auth.requestToken({ grant_type: 'password', username, password });
    setAccessToken(accessToken);
};

/** Create the operator account, then sign in with it. */
export const onboard = async (username: string, password: string): Promise<void> => {
    await wilson.onboarding.createAccount({ username, password });
    await signIn(username, password);
};

/** End the session on the server and forget the token here. The API clears its cookies either way. */
export const signOut = async (): Promise<void> => {
    try {
        await wilson.auth.logout();
    } finally {
        setAccessToken(undefined);
    }
};
