import { SdkError } from '@wilson/sdk';
import { API_BASE, wilson } from './sdk.js';
import { currentAccessToken, refreshSession, setAccessToken } from './session.js';
import { assertPasskey, isPasskeyCancelled } from './webauthn.js';

/** Where the app stands before it can show a board. */
export type SessionState = 'checking' | 'onboarding' | 'signed-out' | 'signed-in';

/**
 * On load: no account yet means onboarding; otherwise try the refresh cookie, which signs a
 * returning operator straight back in. An access token already in memory needs neither.
 */
export const restoreSession = async (): Promise<SessionState> => {
    if (currentAccessToken()) return 'signed-in';
    const { requirements } = await wilson.onboarding.getOnboardingStatus();
    if (requirements.some(requirement => requirement.key === 'account')) return 'onboarding';
    return (await refreshSession(API_BASE)) ? 'signed-in' : 'signed-out';
};

/** Why a sign-in failed, in the operator's words. */
export const signInFailure = (err: unknown): string => {
    if (err instanceof SdkError && err.status === 401) return 'Wrong email or password.';
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

/** A sign-in waiting on its second step: a code from the authenticator app, or a passkey. */
export interface PendingSignIn {
    challengeId: string;
    /** The authenticator app, if one is enrolled. */
    authenticator?: { id: string; label?: string };
    /** Whether a passkey is enrolled. */
    passkey: boolean;
}

/**
 * The first step. With no second factor enrolled this signs in and returns `undefined`; with one, it
 * returns the challenge `completeSignIn` finishes with a code.
 */
export const signIn = async (email: string, password: string): Promise<PendingSignIn | undefined> => {
    const response = await wilson.auth.requestToken({ grant_type: 'password', email, password });
    if (response.result === 'mfa_required' && response.challengeId) {
        const factors = response.factors ?? [];
        const authenticator = factors.find(factor => factor.method === 'authenticator');
        return {
            challengeId: response.challengeId,
            ...(authenticator ? { authenticator: { id: authenticator.id, ...(authenticator.label ? { label: authenticator.label } : {}) } } : {}),
            passkey: factors.some(factor => factor.method === 'passkey'),
        };
    }
    setAccessToken(response.accessToken);
    return undefined;
};

/** The second step: the code from the authenticator app. */
export const completeSignIn = async (pending: PendingSignIn, code: string): Promise<void> => {
    const response = await wilson.auth.requestToken({
        grant_type: 'authenticator',
        challenge_id: pending.challengeId,
        factor_id: pending.authenticator?.id,
        code,
    });
    setAccessToken(response.accessToken);
};

/** The second step with a passkey: a challenge from the API, signed by the browser's passkey prompt. */
export const completeSignInWithPasskey = async (pending: PendingSignIn): Promise<void> => {
    const { passkeyChallengeId, options } = await wilson.auth.startPasskeyChallenge({ challenge_id: pending.challengeId });
    const credential = await assertPasskey(options);
    const response = await wilson.auth.requestToken({
        grant_type: 'passkey',
        challenge_id: pending.challengeId,
        passkey_challenge_id: passkeyChallengeId,
        credential,
    });
    setAccessToken(response.accessToken);
};

/** Why a passkey step failed, in the operator's words. A closed prompt is not a failure. */
export const passkeyFailure = (err: unknown): string | undefined => {
    if (isPasskeyCancelled(err)) return undefined;
    if (err instanceof SdkError && err.status === 401) return 'That passkey was not accepted. Try again, or use another way.';
    return err instanceof SdkError ? 'Could not check the passkey.' : 'Your browser could not use a passkey here.';
};

/** Why a code was refused, in the operator's words. */
export const codeFailure = (err: unknown): string => {
    if (err instanceof SdkError && err.status === 401) return 'That code is wrong or has already been used. Try the next one.';
    if (err instanceof SdkError && err.status === 429) return 'Too many wrong codes. Wait five minutes and try again.';
    return 'Could not reach the API.';
};

/** Create the operator account, then sign in with it. A new account has no second factor yet. */
export const onboard = async (email: string, password: string): Promise<void> => {
    await wilson.onboarding.createAccount({ email, password });
    await signIn(email, password);
};

/** End the session on the server and forget the token here. The API clears its cookies either way. */
export const signOut = async (): Promise<void> => {
    try {
        await wilson.auth.logout();
    } finally {
        setAccessToken(undefined);
    }
};
