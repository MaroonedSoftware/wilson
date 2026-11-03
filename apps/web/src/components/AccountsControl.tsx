import { useState } from 'react';
import { Alert, Badge, Button, Group, Loader, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EngineLimit, EngineTokenSetting, EngineTokenSummary } from '@wilson/sdk';
import {
    ENGINE_LIMITS_QUERY_KEY,
    ENGINE_TOKENS_QUERY_KEY,
    LOCAL_ACCOUNT,
    accountType,
    describeLimit,
    describeSignIn,
    lastPriority,
    limitOn,
    nextAccount,
    outsideRotation,
    rotationOf,
} from '#src/lib/accounts.js';
import { apiErrorMessage } from '#src/lib/api.error.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

const ENGINE_TOKEN_QUERY_KEY = ['settings', 'engine-token'];

/** A limit can lift, or an engine hit one, with nobody touching this page. */
const LIMITS_REFETCH_MS = 60_000;

const ENGINE_TOKEN_SOURCES: Record<EngineTokenSetting['source'], string> = {
    database: 'Engines on this machine sign in with the token saved here.',
    environment: 'Engines on this machine sign in with CLAUDE_CODE_OAUTH_TOKEN from the environment. A token saved here replaces it.',
    none: 'No token is set, so engines on this machine use the login in their Claude config directory.',
};

const useEngineLimits = () => {
    const wilson = useWilsonSdk();
    return useQuery({
        queryKey: ENGINE_LIMITS_QUERY_KEY,
        queryFn: () => wilson.engineTokens.listEngineLimits(),
        refetchInterval: LIMITS_REFETCH_MS,
    });
};

/** Says which account comes next, the question the rest of the section is there to answer. */
function RotationSummary({ rotation, limits }: { rotation: EngineTokenSummary[]; limits: EngineLimit[] }) {
    const next = nextAccount(rotation, limits);
    const [headline, detail] = !next
        ? ['No accounts in rotation', "Engines with no account assigned use their machine's own sign-in."]
        : next.limit
          ? ['Every account in rotation is at its limit', `Stages wait for ${next.name}. ${describeLimit(next.limit)}.`]
          : [
                `Next engine signs in as ${next.name}`,
                'Engines stay on one account until it hits a limit, then move to the next. A host with an account assigned keeps it.',
            ];
    return (
        <Paper bg="var(--mantine-color-default-hover)" p="xs" radius="sm">
            <Text size="sm" fw={500}>
                {headline}
            </Text>
            <Text size="xs" c="dimmed">
                {detail}
            </Text>
        </Paper>
    );
}

/** One saved account: what it is and what is using it. Its token is never shown, since the API never hands it back. */
function AccountRow({
    account,
    next,
    limit,
    onTogglePool,
    onRemove,
    disabled,
}: {
    account: EngineTokenSummary;
    next: boolean;
    limit?: EngineLimit | undefined;
    onTogglePool: () => void;
    onRemove: () => void;
    disabled: boolean;
}) {
    return (
        <Paper withBorder p="xs" radius="sm" aria-label={`account ${account.name}`}>
            <Group justify="space-between" gap="xs" wrap="wrap">
                <Stack gap={2}>
                    <Group gap="xs">
                        <Text size="sm" fw={500}>
                            {account.name}
                        </Text>
                        {next && (
                            <Badge size="sm" variant="light" color="green" tt="none">
                                Next
                            </Badge>
                        )}
                        {limit && (
                            <Badge size="sm" variant="light" color="orange" tt="none">
                                {describeLimit(limit)}
                            </Badge>
                        )}
                        {account.hosts.map(host => (
                            <Badge key={host} size="sm" variant="light" color="blue" tt="none">
                                {host}
                            </Badge>
                        ))}
                    </Group>
                    <Text size="xs" c="dimmed">
                        {accountType(account)}
                    </Text>
                </Stack>
                <Group gap="xs">
                    <Button size="compact-xs" variant="subtle" disabled={disabled} onClick={onTogglePool}>
                        {account.pooled ? 'Leave rotation' : 'Add to rotation'}
                    </Button>
                    <Button size="compact-xs" variant="subtle" color="red" disabled={disabled} onClick={onRemove}>
                        Remove
                    </Button>
                </Group>
            </Group>
        </Paper>
    );
}

/**
 * The named accounts Wilson holds (`EngineTokensService`), grouped by how each is used. Write only, as
 * every credential here is: the list has names and no token, and the fields start empty. Saving under a
 * name already there replaces that token and no other.
 */
export function AccountsControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const tokens = useQuery({ queryKey: ENGINE_TOKENS_QUERY_KEY, queryFn: () => wilson.engineTokens.listEngineTokens() });
    const limits = useEngineLimits();
    const [name, setName] = useState('');
    const [token, setToken] = useState('');

    const refresh = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: ENGINE_TOKENS_QUERY_KEY }),
            queryClient.invalidateQueries({ queryKey: ENGINE_LIMITS_QUERY_KEY }),
        ]);
    const put = useMutation({
        mutationFn: () => wilson.engineTokens.putEngineToken(name.trim(), { token }),
        onSuccess: () => {
            setName('');
            setToken('');
            return refresh();
        },
    });
    const remove = useMutation({ mutationFn: (saved: string) => wilson.engineTokens.removeEngineToken(saved), onSuccess: refresh });
    const setPooled = useMutation({
        mutationFn: ({ saved, pooled, priority }: { saved: string; pooled: boolean; priority?: number }) =>
            wilson.engineTokens.updateEngineToken(saved, { pooled, ...(priority !== undefined && { priority }) }),
        onSuccess: refresh,
    });

    if (tokens.error) {
        return (
            <Alert color="red" title="Cannot load the accounts">
                {apiErrorMessage(tokens.error)}
            </Alert>
        );
    }
    if (!tokens.data) return <Loader size="sm" />;

    const failed = [put, remove, setPooled].find(mutation => mutation.isError);
    const inForce = limits.data ?? [];
    const rotation = rotationOf(tokens.data);
    const codexRotation = rotationOf(tokens.data, 'openai');
    const outside = outsideRotation(tokens.data);
    const next = nextAccount(rotation, inForce);
    const codexNext = nextAccount(codexRotation, inForce);
    const row = (account: EngineTokenSummary, isNext = false) => (
        <AccountRow
            key={account.name}
            account={account}
            next={isNext}
            limit={limitOn(account.name, inForce)}
            disabled={setPooled.isPending || remove.isPending}
            onTogglePool={() =>
                setPooled.mutate(
                    account.pooled
                        ? { saved: account.name, pooled: false }
                        : { saved: account.name, pooled: true, priority: lastPriority(rotationOf(tokens.data, account.provider)) },
                )
            }
            onRemove={() => remove.mutate(account.name)}
        />
    );

    return (
        <Stack gap="sm">
            <RotationSummary rotation={rotation} limits={inForce} />
            {rotation.length > 0 && (
                <Stack gap={4}>
                    <Title order={5}>Rotation</Title>
                    <Text size="xs" c="dimmed">
                        Used by any engine with no account of its own, top first.
                    </Text>
                    {rotation.map(account => row(account, account.name === next?.name && !next.limit))}
                </Stack>
            )}
            {codexRotation.length > 0 && (
                <Stack gap={4}>
                    <Title order={5}>Codex rotation</Title>
                    <Text size="xs" c="dimmed">
                        Used by Codex engines, top first.
                    </Text>
                    {codexRotation.map(account => row(account, account.name === codexNext?.name && !codexNext.limit))}
                </Stack>
            )}
            {outside.length > 0 && (
                <Stack gap={4}>
                    <Title order={5}>Not in rotation</Title>
                    <Text size="xs" c="dimmed">
                        Only a host assigned one of these uses it. Assign them on the Hosts page.
                    </Text>
                    {outside.map(account => row(account))}
                </Stack>
            )}
            <Group gap="xs" align="flex-end">
                <TextInput
                    size="xs"
                    label="Name"
                    value={name}
                    onChange={event => setName(event.currentTarget.value)}
                    disabled={put.isPending}
                    autoComplete="off"
                />
                <PasswordInput
                    size="xs"
                    label="Token"
                    value={token}
                    onChange={event => setToken(event.currentTarget.value)}
                    disabled={put.isPending}
                    autoComplete="off"
                />
                <Button size="xs" disabled={name.trim() === '' || token.trim() === '' || put.isPending} onClick={() => put.mutate()}>
                    Save
                </Button>
            </Group>
            {failed && (
                <Text size="sm" c="red">
                    {apiErrorMessage(failed.error)}
                </Text>
            )}
        </Stack>
    );
}

/**
 * What engines sign in with when no account applies: the saved token (`EngineTokenSettingService`), and
 * any limit on that or on a worker's own sign-in, which have no row above to show it on. Write-only: the
 * API reports where the sign-in comes from and never the token, so the field starts empty, and is emptied
 * again after a save. A refusal keeps the draft, the same choice `ClaudeConfigDirControl` makes.
 */
export function MachineSignInControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: ENGINE_TOKEN_QUERY_KEY, queryFn: () => wilson.settings.getEngineTokenSetting() });
    const tokens = useQuery({ queryKey: ENGINE_TOKENS_QUERY_KEY, queryFn: () => wilson.engineTokens.listEngineTokens() });
    const limits = useEngineLimits();
    const [draft, setDraft] = useState('');

    const mutation = useMutation({
        mutationFn: (token: string | null) => wilson.settings.setEngineTokenSetting({ token }),
        onSuccess: result => {
            queryClient.setQueryData(ENGINE_TOKEN_QUERY_KEY, result);
            setDraft('');
        },
    });

    if (setting.error) {
        return (
            <Alert color="red" title="Cannot load the engine token">
                {apiErrorMessage(setting.error)}
            </Alert>
        );
    }
    if (!setting.data) return <Loader size="sm" />;

    const inForce = limits.data ?? [];
    const saved = new Set((tokens.data ?? []).map(token => token.name));
    const local = limitOn(LOCAL_ACCOUNT, inForce);
    const otherSignIns = [...new Set(inForce.map(limit => limit.account))]
        .filter(account => account !== LOCAL_ACCOUNT && !saved.has(account))
        .flatMap(account => {
            const limit = limitOn(account, inForce);
            return limit ? [{ account, limit }] : [];
        });

    return (
        <Stack gap="xs">
            <PasswordInput
                label="Engine token"
                description="What engines on this machine sign in with, ahead of the config directory below. Make one with claude setup-token. A change applies to stages and planning sessions started afterwards, never one already running."
                value={draft}
                onChange={event => setDraft(event.currentTarget.value)}
                disabled={mutation.isPending}
                autoComplete="off"
            />
            <Group gap="xs">
                <Text size="sm">{ENGINE_TOKEN_SOURCES[setting.data.source]}</Text>
                {local && (
                    <Badge size="sm" variant="light" color="orange" tt="none">
                        {describeLimit(local)}
                    </Badge>
                )}
            </Group>
            {rotationOf(tokens.data ?? []).length > 0 && (
                <Text size="xs" c="dimmed">
                    Not used while rotation has accounts: engines take the first one free.
                </Text>
            )}
            <Group gap="xs">
                <Button size="xs" disabled={draft.trim() === '' || mutation.isPending} onClick={() => mutation.mutate(draft)}>
                    Save
                </Button>
                {setting.data.source === 'database' && (
                    <Button size="xs" variant="default" disabled={mutation.isPending} onClick={() => mutation.mutate(null)}>
                        Remove
                    </Button>
                )}
            </Group>
            {otherSignIns.map(({ account, limit }) => (
                <Text key={account} size="sm" c="orange">
                    {describeSignIn(account)}: {describeLimit(limit)}
                </Text>
            ))}
            {mutation.isError && (
                <Text size="sm" c="red">
                    {apiErrorMessage(mutation.error)}
                </Text>
            )}
        </Stack>
    );
}
