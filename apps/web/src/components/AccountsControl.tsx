import { useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Checkbox, Code, Group, Loader, Menu, Paper, PasswordInput, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconDots, IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EngineLimit, EngineTokenSetting, EngineTokenSummary } from '@wilson/sdk';
import {
    ACCOUNT_TYPES,
    ENGINE_LIMITS_QUERY_KEY,
    ENGINE_TOKENS_QUERY_KEY,
    LOCAL_ACCOUNT,
    accountType,
    describeLimit,
    describeSignIn,
    lastPriority,
    limitOn,
    movedPriorities,
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

/** What removing an account does beyond losing the token, which can't be read back to save it again. */
const removalWarning = ({ name, hosts }: EngineTokenSummary): string => {
    const assigned = hosts.length === 0 ? '' : ` ${hosts.join(', ')} ${hosts.length === 1 ? 'goes' : 'go'} back to the machine's own sign-in.`;
    return `Remove ${name}?${assigned} Running engines carry on, and this doesn't revoke the token with its provider.`;
};

/**
 * One saved account: what it is, what is using it, and what can be done to it. Its token is never shown,
 * since the API never hands it back, so replacing one starts from an empty field. Keeps its own errors,
 * so a refusal appears on the account it is about.
 */
function AccountRow({
    account,
    next,
    limit,
    joinPriority,
    onChanged,
    onMoveUp,
    onMoveDown,
    moving,
}: {
    account: EngineTokenSummary;
    next: boolean;
    limit?: EngineLimit | undefined;
    /** Where this account goes if it joins its provider's rotation. */
    joinPriority: number;
    onChanged: () => Promise<unknown>;
    /** Left out when this account is already at that end, or is not in rotation. */
    onMoveUp?: (() => void) | undefined;
    onMoveDown?: (() => void) | undefined;
    moving: boolean;
}) {
    const wilson = useWilsonSdk();
    const [mode, setMode] = useState<'view' | 'replace' | 'remove'>('view');
    const [token, setToken] = useState('');
    const setPooled = useMutation({
        mutationFn: (pooled: boolean) =>
            wilson.engineTokens.updateEngineToken(account.name, pooled ? { pooled, priority: joinPriority } : { pooled }),
        onSuccess: onChanged,
    });
    const replace = useMutation({
        mutationFn: () => wilson.engineTokens.putEngineToken(account.name, { token }),
        onSuccess: () => {
            setToken('');
            setMode('view');
            return onChanged();
        },
    });
    const remove = useMutation({ mutationFn: () => wilson.engineTokens.removeEngineToken(account.name), onSuccess: onChanged });
    const failed = [setPooled, replace, remove].find(mutation => mutation.isError);
    const busy = moving || setPooled.isPending || replace.isPending || remove.isPending;
    const inRotation = account.pooled && (account.provider === 'anthropic' || account.provider === 'openai');

    return (
        <Paper withBorder p="xs" radius="sm" aria-label={`account ${account.name}`}>
            <Stack gap="xs">
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
                    <Group gap={4}>
                        {inRotation && (
                            <>
                                <ActionIcon variant="subtle" color="gray" aria-label={`Move ${account.name} up`} disabled={!onMoveUp || busy} onClick={onMoveUp}>
                                    <IconArrowUp size={16} />
                                </ActionIcon>
                                <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    aria-label={`Move ${account.name} down`}
                                    disabled={!onMoveDown || busy}
                                    onClick={onMoveDown}
                                >
                                    <IconArrowDown size={16} />
                                </ActionIcon>
                            </>
                        )}
                        {!account.pooled && (
                            <Button size="compact-xs" variant="default" disabled={busy} onClick={() => setPooled.mutate(true)}>
                                Add to rotation
                            </Button>
                        )}
                        <Menu position="bottom-end">
                            <Menu.Target>
                                <ActionIcon variant="subtle" color="gray" aria-label={`More actions for ${account.name}`} disabled={busy}>
                                    <IconDots size={16} />
                                </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                                <Menu.Item onClick={() => setMode('replace')}>Replace token</Menu.Item>
                                {account.pooled && <Menu.Item onClick={() => setPooled.mutate(false)}>Leave rotation</Menu.Item>}
                                <Menu.Item color="red" onClick={() => setMode('remove')}>
                                    Remove
                                </Menu.Item>
                            </Menu.Dropdown>
                        </Menu>
                    </Group>
                </Group>
                {mode === 'replace' && (
                    <Group gap="xs" align="flex-end">
                        <PasswordInput
                            size="xs"
                            label={`New token for ${account.name}`}
                            style={{ flex: 1 }}
                            value={token}
                            onChange={event => setToken(event.currentTarget.value)}
                            disabled={replace.isPending}
                            autoComplete="off"
                        />
                        <Button size="xs" disabled={token.trim() === '' || replace.isPending} onClick={() => replace.mutate()}>
                            Save
                        </Button>
                        <Button
                            size="xs"
                            variant="default"
                            disabled={replace.isPending}
                            onClick={() => {
                                setToken('');
                                setMode('view');
                            }}
                        >
                            Cancel
                        </Button>
                    </Group>
                )}
                {mode === 'remove' && (
                    <Group gap="xs" justify="space-between">
                        <Text size="sm" style={{ flex: 1, minWidth: 200 }}>
                            {removalWarning(account)}
                        </Text>
                        <Group gap="xs">
                            <Button size="xs" color="red" disabled={remove.isPending} onClick={() => remove.mutate()}>
                                Remove account
                            </Button>
                            <Button size="xs" variant="default" disabled={remove.isPending} onClick={() => setMode('view')}>
                                Keep it
                            </Button>
                        </Group>
                    </Group>
                )}
                {failed && (
                    <Text size="sm" c="red">
                        {apiErrorMessage(failed.error)}
                    </Text>
                )}
            </Stack>
        </Paper>
    );
}

/**
 * The form behind "Add account". Refuses a name already saved: the API would replace that token without a
 * word, which is what Replace token is for, and a mistyped name here would quietly lose a working account.
 */
function AddAccountForm({ tokens, onAdded, onClose }: { tokens: EngineTokenSummary[]; onAdded: () => Promise<unknown>; onClose: () => void }) {
    const wilson = useWilsonSdk();
    const [type, setType] = useState(ACCOUNT_TYPES[0]!.value);
    const [name, setName] = useState('');
    const [token, setToken] = useState('');
    const [joinRotation, setJoinRotation] = useState(true);
    const chosen = ACCOUNT_TYPES.find(each => each.value === type) ?? ACCOUNT_TYPES[0]!;
    const taken = tokens.some(saved => saved.name === name.trim());
    const add = useMutation({
        mutationFn: () =>
            wilson.engineTokens.putEngineToken(name.trim(), {
                token,
                provider: chosen.provider,
                kind: chosen.kind,
                ...(joinRotation && { pooled: true, priority: lastPriority(rotationOf(tokens, chosen.provider)) }),
            }),
        onSuccess: async () => {
            await onAdded();
            onClose();
        },
    });

    return (
        <Paper bg="var(--mantine-color-default-hover)" p="sm" radius="sm" aria-label="add account">
            <Stack gap="xs">
                <Text size="xs" c="dimmed">
                    {chosen.kind === 'subscription' ? (
                        <>
                            Run <Code>claude setup-token</Code> in a terminal, signed in as the new account, then paste what it prints.
                        </>
                    ) : (
                        'Paste the API key. It is billed per token, so give it a place low in the rotation.'
                    )}
                </Text>
                <Group gap="xs" align="flex-start" grow>
                    <Select
                        size="xs"
                        label="Type"
                        data={ACCOUNT_TYPES.map(({ value, label }) => ({ value, label }))}
                        value={type}
                        onChange={value => value && setType(value)}
                        allowDeselect={false}
                        disabled={add.isPending}
                    />
                    <TextInput
                        size="xs"
                        label="Name"
                        placeholder="claude-2"
                        value={name}
                        onChange={event => setName(event.currentTarget.value)}
                        error={taken ? 'That name is taken. Use Replace token on that account.' : undefined}
                        disabled={add.isPending}
                        autoComplete="off"
                    />
                    <PasswordInput
                        size="xs"
                        label="Token"
                        value={token}
                        onChange={event => setToken(event.currentTarget.value)}
                        disabled={add.isPending}
                        autoComplete="off"
                    />
                </Group>
                <Checkbox
                    size="xs"
                    label="Add to rotation"
                    checked={joinRotation}
                    onChange={event => setJoinRotation(event.currentTarget.checked)}
                    disabled={add.isPending}
                />
                <Group gap="xs">
                    <Button size="xs" disabled={name.trim() === '' || token.trim() === '' || taken || add.isPending} onClick={() => add.mutate()}>
                        Save account
                    </Button>
                    <Button size="xs" variant="default" disabled={add.isPending} onClick={onClose}>
                        Cancel
                    </Button>
                </Group>
                {add.isError && (
                    <Text size="sm" c="red">
                        {apiErrorMessage(add.error)}
                    </Text>
                )}
            </Stack>
        </Paper>
    );
}

/**
 * The named accounts Wilson holds (`EngineTokensService`), grouped by how each is used. Write only, as
 * every credential here is: the list has names and no token.
 */
export function AccountsControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const tokens = useQuery({ queryKey: ENGINE_TOKENS_QUERY_KEY, queryFn: () => wilson.engineTokens.listEngineTokens() });
    const limits = useEngineLimits();
    const [adding, setAdding] = useState(false);

    const refresh = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: ENGINE_TOKENS_QUERY_KEY }),
            queryClient.invalidateQueries({ queryKey: ENGINE_LIMITS_QUERY_KEY }),
        ]);
    // One request per changed priority, so a failure can leave the order part moved. Reading it back shows where it stopped.
    const move = useMutation({
        mutationFn: async (changes: { name: string; priority: number }[]) => {
            for (const { name, priority } of changes) await wilson.engineTokens.updateEngineToken(name, { priority });
        },
        onSettled: refresh,
    });

    if (tokens.error) {
        return (
            <Alert color="red" title="Cannot load the accounts">
                {apiErrorMessage(tokens.error)}
            </Alert>
        );
    }
    if (!tokens.data) return <Loader size="sm" />;

    const inForce = limits.data ?? [];
    const rotation = rotationOf(tokens.data);
    const codexRotation = rotationOf(tokens.data, 'openai');
    const outside = outsideRotation(tokens.data);
    const row = (account: EngineTokenSummary, order?: EngineTokenSummary[]) => {
        const index = order?.indexOf(account) ?? -1;
        const next = order && nextAccount(order, inForce);
        return (
            <AccountRow
                key={account.name}
                account={account}
                next={next?.name === account.name && !next.limit}
                limit={limitOn(account.name, inForce)}
                joinPriority={lastPriority(rotationOf(tokens.data, account.provider))}
                onChanged={refresh}
                onMoveUp={order && index > 0 ? () => move.mutate(movedPriorities(order, index, -1)) : undefined}
                onMoveDown={order && index < order.length - 1 ? () => move.mutate(movedPriorities(order, index, 1)) : undefined}
                moving={move.isPending}
            />
        );
    };

    return (
        <Stack gap="sm">
            <Group justify="space-between">
                <Title order={4}>Accounts</Title>
                {!adding && (
                    <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
                        Add account
                    </Button>
                )}
            </Group>
            <RotationSummary rotation={rotation} limits={inForce} />
            {adding && <AddAccountForm tokens={tokens.data} onAdded={refresh} onClose={() => setAdding(false)} />}
            {rotation.length > 0 && (
                <Stack gap={4}>
                    <Title order={5}>Rotation</Title>
                    <Text size="xs" c="dimmed">
                        Used by any engine with no account of its own, top first.
                    </Text>
                    {rotation.map(account => row(account, rotation))}
                </Stack>
            )}
            {codexRotation.length > 0 && (
                <Stack gap={4}>
                    <Title order={5}>Codex rotation</Title>
                    <Text size="xs" c="dimmed">
                        Used by Codex engines, top first.
                    </Text>
                    {codexRotation.map(account => row(account, codexRotation))}
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
            {move.isError && (
                <Text size="sm" c="red">
                    {apiErrorMessage(move.error)}
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
    const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');

    const mutation = useMutation({
        mutationFn: (token: string | null) => wilson.settings.setEngineTokenSetting({ token }),
        onSuccess: result => {
            queryClient.setQueryData(ENGINE_TOKEN_QUERY_KEY, result);
            setDraft('');
            setMode('view');
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
            <Group gap="xs" justify="space-between">
                <Group gap="xs" style={{ flex: 1, minWidth: 200 }}>
                    <Text size="sm">{ENGINE_TOKEN_SOURCES[setting.data.source]}</Text>
                    {local && (
                        <Badge size="sm" variant="light" color="orange" tt="none">
                            {describeLimit(local)}
                        </Badge>
                    )}
                </Group>
                {mode === 'view' && (
                    <Group gap="xs">
                        <Button size="compact-xs" variant="default" onClick={() => setMode('edit')}>
                            {setting.data.source === 'database' ? 'Replace token' : 'Add token'}
                        </Button>
                        {setting.data.source === 'database' && (
                            <Button size="compact-xs" variant="subtle" color="red" onClick={() => setMode('remove')}>
                                Remove
                            </Button>
                        )}
                    </Group>
                )}
            </Group>
            {rotationOf(tokens.data ?? []).length > 0 && (
                <Text size="xs" c="dimmed">
                    Not used while rotation has accounts: engines take the first one free.
                </Text>
            )}
            {mode === 'edit' && (
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
                        <Button size="xs" disabled={draft.trim() === '' || mutation.isPending} onClick={() => mutation.mutate(draft)}>
                            Save
                        </Button>
                        <Button
                            size="xs"
                            variant="default"
                            disabled={mutation.isPending}
                            onClick={() => {
                                setDraft('');
                                setMode('view');
                            }}
                        >
                            Cancel
                        </Button>
                    </Group>
                </Stack>
            )}
            {mode === 'remove' && (
                <Group gap="xs" justify="space-between">
                    <Text size="sm" style={{ flex: 1, minWidth: 200 }}>
                        Remove this machine's saved token? Engines here go back to the login in their Claude config directory.
                    </Text>
                    <Group gap="xs">
                        <Button size="xs" color="red" disabled={mutation.isPending} onClick={() => mutation.mutate(null)}>
                            Remove token
                        </Button>
                        <Button size="xs" variant="default" disabled={mutation.isPending} onClick={() => setMode('view')}>
                            Keep it
                        </Button>
                    </Group>
                </Group>
            )}
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
