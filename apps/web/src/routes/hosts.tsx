import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Code, Group, Loader, NumberInput, Paper, Select, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import type { Host, UpdateHostRequest } from '@wilson/sdk';
import { apiErrorMessage } from '#src/lib/api.error.js';
import { listRegisteredProjects } from '#src/lib/projects.js';
import { AnchorLink } from '#src/lib/router-link.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

export const HOSTS_QUERY_KEY = ['hosts'];

/**
 * How often the page re-reads the hosts. The card feed is per project and says nothing about a slot
 * being taken or a probe being recorded, so this polls instead; slots change on the scale of a stage,
 * so a few seconds behind is plenty.
 */
const REFRESH_MS = 10_000;

/** "in 3h 12m", "5m ago": how far `iso` is from `now`, to the minute. */
export function relativeTime(iso: string, now: number): string {
    const minutes = Math.round((Date.parse(iso) - now) / 60_000);
    const span = Math.abs(minutes);
    const text = span < 1 ? 'less than a minute' : span < 60 ? `${span}m` : `${Math.floor(span / 60)}h ${span % 60}m`;
    return minutes >= 0 ? `in ${text}` : `${text} ago`;
}

/** Whether a host takes new stages, and if not, which switch says so. */
function StateBadge({ host }: { host: Host }) {
    if (!host.enabled) return <Badge color="gray">disabled</Badge>;
    if (host.draining) return <Badge color="yellow">draining</Badge>;
    return <Badge color="green">enabled</Badge>;
}

/** The last probe's verdict, with its detail on hover. */
function ProbeBadge({ host, now }: { host: Host; now: number }) {
    const probe = host.probe;
    if (!probe)
        return (
            <Badge variant="outline" color="gray">
                never probed
            </Badge>
        );
    return (
        <Tooltip label={probe.detail ?? 'every check passed'} multiline w={320}>
            <Badge variant="light" color={probe.ok ? 'green' : 'red'}>
                {probe.ok ? 'probe ok' : 'probe failed'} {relativeTime(probe.probedAt, now)}
            </Badge>
        </Tooltip>
    );
}

/**
 * One host: what it is, whether it takes work, what its last probe found, what it is running, and the
 * projects it serves. Every action goes through the API and the page shows what came back, so a
 * refused write never shows as applied.
 */
function HostPanel({ host, projects, now }: { host: Host; projects: string[]; now: number }) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const [confirmRemove, setConfirmRemove] = useState(false);

    const refresh = () => queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY });
    const update = useMutation({ mutationFn: (patch: UpdateHostRequest) => wilson.hosts.updateHost(host.name, patch), onSuccess: refresh });
    const probe = useMutation({ mutationFn: () => wilson.hosts.probeHost(host.name), onSuccess: refresh });
    const remove = useMutation({ mutationFn: () => wilson.hosts.removeHost(host.name), onSuccess: refresh });
    const unserve = useMutation({ mutationFn: (project: string) => wilson.hosts.removeHostProject(host.name, project), onSuccess: refresh });
    const busy = update.isPending || probe.isPending || remove.isPending;
    const failed = [update, probe, remove, unserve].find(mutation => mutation.isError);

    return (
        <Paper withBorder p="md" aria-label={`host ${host.name}`}>
            <Stack gap="sm">
                <Group justify="space-between" align="flex-start">
                    <Stack gap={4}>
                        <Group gap="xs">
                            <Title order={4}>{host.name}</Title>
                            <StateBadge host={host} />
                            <ProbeBadge host={host} now={now} />
                        </Group>
                        <Text size="sm" c="dimmed">
                            ssh <Code>{host.sshTarget}</Code>
                            {host.probe?.engineVersion && <> · claude {host.probe.engineVersion}</>}
                            {host.probe?.expiresAt && <> · expires {relativeTime(host.probe.expiresAt, now)}</>}
                            {host.lifetimeMinutes && !host.probe?.expiresAt && <> · lives {host.lifetimeMinutes}m after boot</>}
                            {host.commandEnv.length > 0 && <> · commands get {host.commandEnv.join(', ')} from it</>}
                        </Text>
                    </Stack>
                    <Group gap="xs">
                        <Button size="xs" variant="default" loading={probe.isPending} disabled={busy || !host.enabled} onClick={() => probe.mutate()}>
                            Probe
                        </Button>
                        <Button size="xs" variant="default" disabled={busy} onClick={() => update.mutate({ draining: !host.draining })}>
                            {host.draining ? 'Undrain' : 'Drain'}
                        </Button>
                        <Button size="xs" variant="default" disabled={busy} onClick={() => update.mutate({ enabled: !host.enabled })}>
                            {host.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                            size="xs"
                            color="red"
                            variant={confirmRemove ? 'filled' : 'subtle'}
                            disabled={busy}
                            onClick={() => (confirmRemove ? remove.mutate() : setConfirmRemove(true))}
                            onBlur={() => setConfirmRemove(false)}
                        >
                            {confirmRemove ? 'Confirm remove' : 'Remove'}
                        </Button>
                    </Group>
                </Group>

                {failed && (
                    <Text size="sm" c="red">
                        {apiErrorMessage(failed.error)}
                    </Text>
                )}
                {host.probe && !host.probe.ok && host.probe.detail && (
                    <Alert color="red" variant="light" title="Last probe failed">
                        {host.probe.detail}
                    </Alert>
                )}

                <Stack gap={4}>
                    <Text size="sm" fw={500}>
                        {host.running.length} of {host.slots} slot{host.slots === 1 ? '' : 's'} in use
                    </Text>
                    {host.running.map(use => (
                        <Text size="sm" key={use.slot}>
                            slot {use.slot}:{' '}
                            <AnchorLink to="/projects/$project/cards/$cardId" params={{ project: use.project, cardId: use.cardId }} size="sm">
                                {use.project} {use.cardId}
                            </AnchorLink>{' '}
                            <Text span size="sm" c="dimmed">
                                since {relativeTime(use.since, now)}
                            </Text>
                        </Text>
                    ))}
                </Stack>

                <Stack gap={4}>
                    <Text size="sm" fw={500}>
                        Projects
                    </Text>
                    {host.projects.length === 0 ? (
                        <Text size="sm" c="dimmed">
                            Serves no project yet, so no stage is placed here.
                        </Text>
                    ) : (
                        <Table fz="sm" withRowBorders={false}>
                            <Table.Tbody>
                                {host.projects.map(project => (
                                    <Table.Tr key={project.project}>
                                        <Table.Td fw={500}>{project.project}</Table.Td>
                                        <Table.Td>
                                            <Code>{project.codeRoot}</Code>
                                        </Table.Td>
                                        <Table.Td c="dimmed">worktrees {project.worktreeRoot}</Table.Td>
                                        <Table.Td c="dimmed">run {project.runRoot}</Table.Td>
                                        <Table.Td>
                                            <Button size="compact-xs" variant="subtle" color="red" onClick={() => unserve.mutate(project.project)}>
                                                Stop serving
                                            </Button>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    )}
                    <ServeProjectForm host={host} projects={projects.filter(name => !host.projects.some(p => p.project === name))} />
                </Stack>
            </Stack>
        </Paper>
    );
}

/** Let a host run a project's stages, naming where that project's clone is on it. */
function ServeProjectForm({ host, projects }: { host: Host; projects: string[] }) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const [project, setProject] = useState<string | null>(null);
    const [codeRoot, setCodeRoot] = useState('');
    const [worktreeRoot, setWorktreeRoot] = useState('');
    const [runRoot, setRunRoot] = useState('');

    const serve = useMutation({
        mutationFn: () => wilson.hosts.setHostProject(host.name, project!, { codeRoot, worktreeRoot, runRoot }),
        onSuccess: () => {
            setProject(null);
            setCodeRoot('');
            setWorktreeRoot('');
            setRunRoot('');
            return queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY });
        },
    });

    if (projects.length === 0) return null;
    const ready = project && codeRoot && worktreeRoot && runRoot;

    return (
        <Stack gap="xs" mt="xs">
            <Group align="flex-end" gap="xs" wrap="wrap">
                <Select label="Serve a project" placeholder="Project" data={projects} value={project} onChange={setProject} w={160} size="xs" />
                <TextInput
                    label="Clone on the host"
                    placeholder="/opt/agent/TGA"
                    value={codeRoot}
                    onChange={e => setCodeRoot(e.currentTarget.value)}
                    size="xs"
                />
                <TextInput
                    label="Worktree root"
                    placeholder="/opt/agent/worktrees"
                    value={worktreeRoot}
                    onChange={e => setWorktreeRoot(e.currentTarget.value)}
                    size="xs"
                />
                <TextInput
                    label="Run root"
                    placeholder="/opt/agent/run"
                    value={runRoot}
                    onChange={e => setRunRoot(e.currentTarget.value)}
                    size="xs"
                />
                <Button size="xs" disabled={!ready} loading={serve.isPending} onClick={() => serve.mutate()}>
                    Serve
                </Button>
            </Group>
            {serve.isError && (
                <Text size="sm" c="red">
                    {apiErrorMessage(serve.error)}
                </Text>
            )}
        </Stack>
    );
}

/** Register a host: its name, what `ssh` connects to, its slots and, for an agent VM, its lifetime. */
function RegisterHostForm() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const [name, setName] = useState('');
    const [sshTarget, setSshTarget] = useState('');
    const [slots, setSlots] = useState<number | ''>(1);
    const [lifetime, setLifetime] = useState<number | ''>('');
    const [commandEnv, setCommandEnv] = useState('');

    const register = useMutation({
        mutationFn: () =>
            wilson.hosts.registerHost({
                name: name.trim(),
                ...(sshTarget.trim() && { sshTarget: sshTarget.trim() }),
                ...(slots !== '' && { slots }),
                ...(lifetime !== '' && { lifetimeMinutes: lifetime }),
                ...(commandEnv.trim() && {
                    commandEnv: commandEnv
                        .split(',')
                        .map(name => name.trim())
                        .filter(Boolean),
                }),
            }),
        onSuccess: () => {
            setName('');
            setSshTarget('');
            setSlots(1);
            setLifetime('');
            setCommandEnv('');
            return queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY });
        },
    });

    return (
        <Paper withBorder p="md">
            <Stack gap="xs">
                <Title order={5}>Register a host</Title>
                <Group align="flex-end" gap="xs" wrap="wrap">
                    <TextInput label="Name" placeholder="agent-3" value={name} onChange={e => setName(e.currentTarget.value)} size="xs" />
                    <TextInput
                        label="SSH target"
                        placeholder="defaults to the name"
                        value={sshTarget}
                        onChange={e => setSshTarget(e.currentTarget.value)}
                        size="xs"
                    />
                    <NumberInput
                        label="Slots"
                        min={1}
                        max={8}
                        value={slots}
                        onChange={value => setSlots(value === '' ? '' : Number(value))}
                        w={80}
                        size="xs"
                    />
                    <NumberInput
                        label="Lifetime (minutes)"
                        placeholder="720 for an agent VM"
                        min={1}
                        value={lifetime}
                        onChange={value => setLifetime(value === '' ? '' : Number(value))}
                        w={160}
                        size="xs"
                    />
                    <TextInput
                        label="Command env"
                        description="From the host, for setup and tests"
                        placeholder="GITHUB_TOKEN"
                        value={commandEnv}
                        onChange={e => setCommandEnv(e.currentTarget.value)}
                        size="xs"
                    />
                    <Button size="xs" disabled={!name.trim()} loading={register.isPending} onClick={() => register.mutate()}>
                        Register
                    </Button>
                </Group>
                {register.isError && (
                    <Text size="sm" c="red">
                        {apiErrorMessage(register.error)}
                    </Text>
                )}
            </Stack>
        </Paper>
    );
}

/**
 * `/hosts`: the machines besides this one that card stages can run on (`hosts.ck`), for managing them
 * and seeing what each is doing. Deployment-wide like `/settings`, so it reads through the unscoped
 * client `__root.tsx` provides, and project names come from the same `['registered-projects']` query
 * the dashboard and the project switcher share.
 */
function HostsRoute() {
    const wilson = useWilsonSdk();
    const hosts = useQuery({ queryKey: HOSTS_QUERY_KEY, queryFn: () => wilson.hosts.listHosts(), refetchInterval: REFRESH_MS });
    const projects = useQuery({ queryKey: ['registered-projects'], queryFn: listRegisteredProjects });
    const now = hosts.dataUpdatedAt || Date.now();

    return (
        <Stack gap="md" maw={1100}>
            <Stack gap={4}>
                <Title order={2}>Hosts</Title>
                <Text size="sm" c="dimmed">
                    Machines a stage with <Code>placement: any</Code> or <Code>placement: remote</Code> can run on, reached over SSH. A host takes a
                    stage when it is enabled, not draining, serves the card&apos;s project, passed its last probe and will not expire first.
                </Text>
            </Stack>

            {hosts.error && (
                <Alert color="red" title="Cannot load hosts">
                    {apiErrorMessage(hosts.error)}
                </Alert>
            )}
            {!hosts.data && !hosts.error && <Loader size="sm" />}
            {hosts.data?.length === 0 && (
                <Text size="sm" c="dimmed">
                    No hosts yet. Register one below, or with <Code>wilson host add</Code>.
                </Text>
            )}
            {hosts.data?.map(host => (
                <HostPanel key={host.name} host={host} projects={(projects.data ?? []).map(p => p.name)} now={now} />
            ))}

            <RegisterHostForm />
        </Stack>
    );
}

export const Route = createFileRoute('/hosts')({ component: HostsRoute });
