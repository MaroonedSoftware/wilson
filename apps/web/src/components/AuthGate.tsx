import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Center, Loader, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { WilsonMark } from '#src/components/brand/WilsonMark.js';
import { onboard, onboardingFailure, restoreSession, signIn, signInFailure, type SessionState } from '#src/lib/auth.js';
import { currentAccessToken, onSessionChange } from '#src/lib/session.js';

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

/** The sign-in form. A wrong password and a lockout are told apart, in plain words. */
export function SignInForm({ unreachable = false }: { unreachable?: boolean }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [failure, setFailure] = useState<string | undefined>(unreachable ? 'Could not reach the API.' : undefined);
    const [pending, setPending] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setFailure(undefined);
        try {
            await signIn(username, password);
        } catch (err) {
            setFailure(signInFailure(err));
            setPending(false);
        }
    };

    return (
        <Panel title="Sign in" description="Sign in to your wilson board.">
            <form onSubmit={submit}>
                <Stack gap="sm">
                    <TextInput
                        label="Username"
                        autoComplete="username"
                        value={username}
                        onChange={e => setUsername(e.currentTarget.value)}
                        required
                    />
                    <PasswordInput
                        label="Password"
                        autoComplete="current-password"
                        value={password}
                        onChange={e => setPassword(e.currentTarget.value)}
                        required
                    />
                    {failure && <Alert color="red">{failure}</Alert>}
                    <Button type="submit" loading={pending}>
                        Sign in
                    </Button>
                </Stack>
            </form>
        </Panel>
    );
}

/**
 * First-run onboarding: the one operator account. Asks for the password twice, since there is no
 * reset by email to fall back on.
 */
export function OnboardingForm() {
    const [username, setUsername] = useState('');
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
            await onboard(username, password);
        } catch (err) {
            setFailure(onboardingFailure(err));
            setPending(false);
        }
    };

    return (
        <Panel title="Create your account" description="wilson has one account: yours. Choose a username and a password to sign in with.">
            <form onSubmit={submit}>
                <Stack gap="sm">
                    <TextInput
                        label="Username"
                        autoComplete="username"
                        value={username}
                        onChange={e => setUsername(e.currentTarget.value)}
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
