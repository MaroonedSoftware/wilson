import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Code, Group, Image, Stack, Text, TextInput } from '@mantine/core';
import type { AuthenticatorRegistration } from '@wilson/sdk';
import { codeFailure, passkeyFailure } from '#src/lib/auth.js';
import { reasonFor } from '#src/lib/mutations.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';
import { createPasskey, passkeysAvailable } from '#src/lib/webauthn.js';

const FACTORS_KEY = ['auth', 'factors'];

/**
 * The settings page's Security section: the operator's second factors, an authenticator app and
 * passkeys (PROJECT.md, Authentication: Factors). With one enrolled, signing in asks for it after the
 * password. Passkeys are offered only where the browser can make one (`passkeysAvailable`). Adding or removing one needs a recent sign-in, and the step-up dialog asks for it when
 * the session is older than five minutes.
 */
export function SecurityControls() {
    const sdk = useWilsonSdk();
    const queryClient = useQueryClient();
    const factors = useQuery({ queryKey: FACTORS_KEY, queryFn: () => sdk.factors.listSecondFactors() });
    const [registration, setRegistration] = useState<AuthenticatorRegistration | undefined>(undefined);
    const [code, setCode] = useState('');
    const [failure, setFailure] = useState<string | undefined>(undefined);

    const start = useMutation({
        mutationFn: () => sdk.factors.startAuthenticator({ label: 'wilson' }),
        onSuccess: setRegistration,
        onError: err => setFailure(reasonFor(err)),
    });
    const verify = useMutation({
        mutationFn: (registrationId: string) => sdk.factors.verifyAuthenticator({ registrationId, code: code.trim() }),
        onSuccess: () => {
            setRegistration(undefined);
            setCode('');
            void queryClient.invalidateQueries({ queryKey: FACTORS_KEY });
        },
        onError: err => setFailure(codeFailure(err)),
    });
    const addPasskey = useMutation({
        mutationFn: async () => {
            const { registrationId, options } = await sdk.factors.startPasskey({ label: navigator.platform || 'this device' });
            const credential = await createPasskey(options);
            return sdk.factors.verifyPasskey({ registrationId, credential });
        },
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: FACTORS_KEY }),
        onError: err => setFailure(passkeyFailure(err)),
    });
    const remove = useMutation({
        mutationFn: (id: string) => sdk.factors.removeSecondFactor(id),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: FACTORS_KEY }),
        onError: err => setFailure(reasonFor(err)),
    });

    const submitCode = (event: FormEvent) => {
        event.preventDefault();
        setFailure(undefined);
        if (registration) verify.mutate(registration.registrationId);
    };

    const enrolled = factors.data ?? [];

    return (
        <Stack gap="sm">
            <Text size="sm" c="dimmed">
                A second factor makes signing in need your phone or a passkey as well as your password. The CLI can use an authenticator app but not a
                passkey, so set up an authenticator app too if you edit stage config from the CLI.
            </Text>
            {enrolled.map(factor => (
                <Group key={factor.id} justify="space-between">
                    <Text size="sm">
                        {factor.method === 'passkey' ? 'Passkey' : 'Authenticator app'}
                        {factor.label ? ` (${factor.label})` : ''}
                    </Text>
                    <Button size="xs" variant="subtle" color="red" loading={remove.isPending} onClick={() => remove.mutate(factor.id)}>
                        Remove
                    </Button>
                </Group>
            ))}
            {registration ? (
                <form onSubmit={submitCode}>
                    <Stack gap="sm">
                        <Text size="sm">Scan this with your authenticator app, then enter the code it shows.</Text>
                        <Image src={registration.qrCode} alt="Authenticator QR code" w={180} h={180} />
                        <Text size="xs" c="dimmed">
                            Can't scan it? Enter this key: <Code>{registration.secret}</Code>
                        </Text>
                        <TextInput
                            label="Code"
                            autoComplete="one-time-code"
                            inputMode="numeric"
                            value={code}
                            onChange={e => setCode(e.currentTarget.value)}
                            required
                        />
                        <Group>
                            <Button type="submit" size="xs" loading={verify.isPending}>
                                Turn on
                            </Button>
                            <Button size="xs" variant="subtle" onClick={() => setRegistration(undefined)}>
                                Cancel
                            </Button>
                        </Group>
                    </Stack>
                </form>
            ) : (
                <Group>
                    {!enrolled.some(factor => factor.method === 'authenticator') && (
                        <Button size="xs" loading={start.isPending} onClick={() => start.mutate()}>
                            Set up an authenticator app
                        </Button>
                    )}
                    {passkeysAvailable() && (
                        <Button size="xs" variant="default" loading={addPasskey.isPending} onClick={() => addPasskey.mutate()}>
                            Add a passkey
                        </Button>
                    )}
                </Group>
            )}
            {failure && <Alert color="red">{failure}</Alert>}
        </Stack>
    );
}
