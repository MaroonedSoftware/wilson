import type { ReactNode } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Code, Group, Loader, Paper, Stack, Switch, Text, Title } from '@mantine/core';
import { SdkError } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';

const POLLER_QUERY_KEY = ['settings', 'poller'];

/**
 * The server's own sentence for a refusal — `errorMiddleware`'s body is `{ statusCode, message,
 * details }` (`@maroonedsoftware/koa`), so `SdkError.body.message` is that sentence. Falls back to
 * the SDK's generic "<status> <statusText>" only when the body isn't that shape, which happens for
 * a network failure that never reached the server.
 */
function apiErrorMessage(error: unknown): string {
    if (error instanceof SdkError && error.body && typeof error.body === 'object' && 'message' in error.body) {
        const message = (error.body as { message: unknown }).message;
        if (typeof message === 'string') return message;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * The one control this card adds: `POLLER_ENABLED`, readable and settable at runtime (card 0106).
 * Renders whatever `setPollerSetting` hands back rather than the value clicked — a write the server
 * refuses must not show as applied, so the query cache only ever holds a value that round-tripped.
 */
function AutoModeToggle() {
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: POLLER_QUERY_KEY, queryFn: () => wilson.settings.getPollerSetting() });
    const mutation = useMutation({
        mutationFn: (enabled: boolean) => wilson.settings.setPollerSetting({ enabled }),
        onSuccess: result => queryClient.setQueryData(POLLER_QUERY_KEY, result),
    });

    if (setting.error) {
        return (
            <Alert color="red" title="Cannot load auto-mode">
                {apiErrorMessage(setting.error)}
            </Alert>
        );
    }
    if (!setting.data) return <Loader size="sm" />;

    return (
        <Stack gap="xs">
            <Switch
                label="Auto-mode"
                description="Whether the runner picks up cards on its own, without a human dispatching them."
                checked={setting.data.enabled}
                disabled={mutation.isPending}
                onChange={event => mutation.mutate(event.currentTarget.checked)}
            />
            {mutation.isError && (
                <Text size="sm" c="red">
                    {apiErrorMessage(mutation.error)}
                </Text>
            )}
        </Stack>
    );
}

/** A `project`/`head`/`startedAt`/root row: a label column and a value, greyed for the read-only roots. */
function Fact({ label, children, muted }: { label: string; children: ReactNode; muted?: boolean }) {
    return (
        <Group gap="xs" wrap="nowrap">
            <Text size="sm" c="dimmed" w={100} style={{ flexShrink: 0 }}>
                {label}
            </Text>
            <Code c={muted ? 'dimmed' : undefined}>{children}</Code>
        </Group>
    );
}

/**
 * What this process is and where it runs. `boardRoot`, `codeRoot` and `worktreeRoot` are
 * deployment topology (card 0106's rule, extended to this endpoint by card 0114) — shown greyed,
 * with a line saying why, rather than left for an operator to go hunting for an edit control that
 * does not exist.
 */
function DeploymentFacts() {
    const health = useQuery({ queryKey: ['health'], queryFn: () => wilson.health.getHealth() });

    if (health.error) {
        return (
            <Alert color="red" title="Cannot load deployment facts">
                {apiErrorMessage(health.error)}
            </Alert>
        );
    }
    if (!health.data) return <Loader size="sm" />;

    return (
        <Stack gap="xs">
            <Fact label="Project">{health.data.project}</Fact>
            <Fact label="Commit">{health.data.head}</Fact>
            <Fact label="Started">{new Date(health.data.startedAt).toLocaleString()}</Fact>
            <Fact label="Board root" muted>
                {health.data.boardRoot}
            </Fact>
            <Fact label="Code root" muted>
                {health.data.codeRoot}
            </Fact>
            <Fact label="Worktree root" muted>
                {health.data.worktreeRoot}
            </Fact>
            <Text size="xs" c="dimmed">
                Board, code and worktree roots are environment-only — set at deploy time, not editable here.
                Changing them out from under a running daemon is a redeploy, not a setting.
            </Text>
        </Stack>
    );
}

/**
 * Settings: card 0114's slice of what card 0106 put behind the API — the page itself, the
 * auto-mode toggle, and the read-only deployment facts above. The interval, concurrency and
 * webhook/base-URL fields are not here yet: they are cards [[0115]] and [[0116]].
 */
function SettingsRoute() {
    return (
        <Stack gap="lg">
            <Anchor component={Link} to="/" size="sm">
                ← Back to the board
            </Anchor>
            <Title order={2}>Settings</Title>

            <Paper withBorder p="md" radius="sm">
                <Stack gap="sm">
                    <Title order={4}>Auto-mode</Title>
                    <AutoModeToggle />
                </Stack>
            </Paper>

            <Paper withBorder p="md" radius="sm">
                <Stack gap="sm">
                    <Title order={4}>Deployment</Title>
                    <DeploymentFacts />
                </Stack>
            </Paper>
        </Stack>
    );
}

export const Route = createFileRoute('/settings')({ component: SettingsRoute });
