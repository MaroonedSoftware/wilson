import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Center, Loader, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { WilsonMark } from '#src/components/brand/WilsonMark.js';
import {
    codeFailure,
    completeSignIn,
    completeSignInWithPasskey,
    onboard,
    onboardingFailure,
    passkeyFailure,
    restoreSession,
    signIn,
    signInFailure,
    type PendingSignIn,
    type SessionState,
} from '#src/lib/auth.js';
import { currentAccessToken, onSessionChange } from '#src/lib/session.js';
import { passkeysAvailable } from '#src/lib/webauthn.js';

/**
 * Nothing below this renders without a session (PROJECT.md, Authentication). On load it restores
 * one from the refresh cookie (`restoreSession`), and otherwise shows first-run onboarding (no
 * account yet) or the sign-in form. It also listens for the session ending later, a refresh that
 * fails because the session was revoked, and drops back to sign-in when it does.
 */
export function AuthGate({ children }: { children: ReactNode }) {
    const [state, setState] = useState<SessionState>(() => (currentAccessToken() ? 'signed-in' : 'checking'));
    const [unreachable, setUnreachable] = useState(false);

    useEffect(() => {
        if (state !== 'checking') return;
        restoreSession()
            .then(setState)
            .catch(() => {
                setUnreachable(true);
                setState('signed-out');
            });
    }, [state]);

    useEffect(
        () =>
            onSessionChange(() => {
                if (currentAccessToken()) {
                    setUnreachable(false);
                    setState('signed-in');
                } else {
                    setState(previous => (previous === 'onboarding' ? previous : 'signed-out'));
                }
            }),
        [],
    );

    if (state === 'checking') {
        return (
            <Center h="100vh">
                <Loader aria-label="Checking your session" />
            </Center>
        );
    }
    if (state === 'onboarding') return <OnboardingForm />;
    if (state === 'signed-out') return <SignInForm unreachable={unreachable} />;
    return <>{children}</>;
}

function Panel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
    return (
        <Center h="100vh" p="md">
            <Paper withBorder p="xl" w={380} maw="100%">
                <Stack gap="md">
                    <Stack gap={4} align="center">
                        <WilsonMark size={40} />
                        <Title order={3}>{title}</Title>
                        <Text size="sm" c="dimmed" ta="center">
                            {description}
                        </Text>
                    </Stack>
                    {children}
                </Stack>
            </Paper>
        </Center>
    );
}

/**
 * Email and password, then, if the account has a second factor enrolled, its code or its passkey.
 * Calls `onSignedIn` once a session is in place. Shared by the sign-in page and the step-up dialog.
 */
export function CredentialsSteps({
    initialFailure,
    submitLabel,
    onSignedIn,
}: {
    initialFailure?: string;
    submitLabel: string;
    onSignedIn?: () => void;
}) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [challenge, setChallenge] = useState<PendingSignIn | undefined>(undefined);
    const [failure, setFailure] = useState<string | undefined>(initialFailure);
    const [pending, setPending] = useState(false);

    const submitPassword = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setFailure(undefined);
        try {
            const next = await signIn(email, password);
            setPending(false);
            if (next) setChallenge(next);
            else onSignedIn?.();
        } catch (err) {
            setFailure(signInFailure(err));
            setPending(false);
        }
    };

    const submitCode = async (event: FormEvent) => {
        event.preventDefault();
        if (!challenge) return;
        setPending(true);
        setFailure(undefined);
        try {
            await completeSignIn(challenge, code);
            setPending(false);
            onSignedIn?.();
        } catch (err) {
            setFailure(codeFailure(err));
            setCode('');
            setPending(false);
        }
    };

    const usePasskey = async () => {
        if (!challenge) return;
        setPending(true);
        setFailure(undefined);
        try {
            await completeSignInWithPasskey(challenge);
            setPending(false);
            onSignedIn?.();
        } catch (err) {
            setFailure(passkeyFailure(err));
            setPending(false);
        }
    };

    if (challenge) {
        const offerPasskey = challenge.passkey && passkeysAvailable();
        return (
            <Stack gap="sm">
                {offerPasskey && (
                    <Button onClick={() => void usePasskey()} loading={pending && !code}>
                        Use your passkey
                    </Button>
                )}
                {challenge.authenticator && (
                    <form onSubmit={submitCode}>
                        <Stack gap="sm">
                            <TextInput
                                label="Code"
                                description={`From your authenticator app${challenge.authenticator.label ? ` (${challenge.authenticator.label})` : ''}.`}
                                autoComplete="one-time-code"
                                inputMode="numeric"
                                value={code}
                                onChange={e => setCode(e.currentTarget.value)}
                                required
                                autoFocus={!offerPasskey}
                            />
                            <Button type="submit" variant={offerPasskey ? 'default' : 'filled'} loading={pending && !!code}>
                                Verify
                            </Button>
                        </Stack>
                    </form>
                )}
                {!offerPasskey && !challenge.authenticator && (
                    <Alert color="yellow">
                        This account signs in with a passkey, which this browser cannot use here. Open wilson over https or on localhost.
                    </Alert>
                )}
                {failure && <Alert color="red">{failure}</Alert>}
            </Stack>
        );
    }

    return (
        <form onSubmit={submitPassword}>
            <Stack gap="sm">
                <TextInput label="Email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.currentTarget.value)} required />
                <PasswordInput
                    label="Password"
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.currentTarget.value)}
                    required
                />
                {failure && <Alert color="red">{failure}</Alert>}
                <Button type="submit" loading={pending}>
                    {submitLabel}
                </Button>
            </Stack>
        </form>
    );
}

/** The sign-in page. A wrong password, a wrong code and a lockout are told apart, in plain words. */
export function SignInForm({ unreachable = false }: { unreachable?: boolean }) {
    return (
        <Panel title="Sign in" description="Sign in to your wilson board.">
            <CredentialsSteps submitLabel="Sign in" initialFailure={unreachable ? 'Could not reach the API.' : undefined} />
        </Panel>
    );
}

/**
 * First-run onboarding: the one operator account. Asks for the password twice, since there is no
 * reset by email to fall back on.
 */
export function OnboardingForm() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [failure, setFailure] = useState<string | undefined>(undefined);
    const [pending, setPending] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (password !== confirmation) {
            setFailure('The passwords do not match.');
            return;
        }
        setPending(true);
        setFailure(undefined);
        try {
            await onboard(email, password);
        } catch (err) {
            setFailure(onboardingFailure(err));
            setPending(false);
        }
    };

    return (
        <Panel title="Create your account" description="wilson has one account: yours. Choose the email address and password you will sign in with. wilson never sends mail to it.">
            <form onSubmit={submit}>
                <Stack gap="sm">
                    <TextInput
                        label="Email"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={e => setEmail(e.currentTarget.value)}
                        required
                    />
                    <PasswordInput
                        label="Password"
                        description="At least 8 characters, and hard to guess."
                        autoComplete="new-password"
                        value={password}
                        onChange={e => setPassword(e.currentTarget.value)}
                        required
                    />
                    <PasswordInput
                        label="Confirm password"
                        autoComplete="new-password"
                        value={confirmation}
                        onChange={e => setConfirmation(e.currentTarget.value)}
                        required
                    />
                    {failure && <Alert color="red">{failure}</Alert>}
                    <Button type="submit" loading={pending}>
                        Create account
                    </Button>
                </Stack>
            </form>
        </Panel>
    );
}
