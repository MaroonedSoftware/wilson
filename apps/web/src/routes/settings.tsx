import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Button, Code, Group, Loader, NumberInput, Paper, Stack, Switch, Text, Title } from '@mantine/core';
import { SdkError } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';

const POLLER_QUERY_KEY = ['settings', 'poller'];
const POLLER_INTERVAL_QUERY_KEY = ['settings', 'poller-interval'];
const CARD_STAGE_CONCURRENCY_QUERY_KEY = ['settings', 'card-stage-concurrency'];

// Display-only hints for the `NumberInput`s below — clamping here is a convenience, not
// enforcement. The API refuses out of range regardless of what these let a user type up to
// (`job.runner.config.ts` carries the real bounds and the reasoning); a stale hint here would only
// ever make the control feel wrong, never make an out-of-range value reach the server unrefused.
const POLLER_INTERVAL_MIN_MS = 5_000;
const POLLER_INTERVAL_MAX_MS = 300_000;
const CARD_STAGE_CONCURRENCY_MIN = 1;
const CARD_STAGE_CONCURRENCY_MAX = 8;

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

/**
 * How often the poller ticks (card 0115). Unlike `AutoModeToggle`, a write here has nowhere to be
 * pushed into a running daemon — `Poller.loop` (poller.ts) reads the setting itself on every tick —
 * so this control has nothing to do after a successful save beyond showing the value that
 * round-tripped, the same rule `AutoModeToggle` follows.
 *
 * A local `draft` separate from the query's own data because typing a new number must not fire a
 * request per keystroke — `Save` is the only thing that does, and only once the typed value differs
 * from what is currently in effect.
 */
function PollerIntervalControl() {
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: POLLER_INTERVAL_QUERY_KEY, queryFn: () => wilson.settings.getPollerInterval() });
    const [draft, setDraft] = useState<number | ''>('');

    useEffect(() => {
        if (setting.data) setDraft(setting.data.intervalMs);
    }, [setting.data]);

    const mutation = useMutation({
        mutationFn: (intervalMs: number) => wilson.settings.setPollerInterval({ intervalMs }),
        onSuccess: result => {
            queryClient.setQueryData(POLLER_INTERVAL_QUERY_KEY, result);
            setDraft(result.intervalMs);
        },
    });

    if (setting.error) {
        return (
            <Alert color="red" title="Cannot load poll interval">
                {apiErrorMessage(setting.error)}
            </Alert>
        );
    }
    if (!setting.data) return <Loader size="sm" />;

    const dirty = draft !== '' && draft !== setting.data.intervalMs;

    return (
        <Stack gap="xs">
            <NumberInput
                label="Poll interval (ms)"
                description="How often the poller checks the board for a card to enqueue."
                value={draft}
                onChange={value => setDraft(value === '' ? '' : Number(value))}
                min={POLLER_INTERVAL_MIN_MS}
                max={POLLER_INTERVAL_MAX_MS}
                step={1_000}
                disabled={mutation.isPending}
                maw={220}
            />
            <Group gap="xs">
                <Button size="xs" disabled={!dirty || mutation.isPending} onClick={() => dirty && mutation.mutate(draft as number)}>
                    Save
                </Button>
            </Group>
            {mutation.isError && (
                <Text size="sm" c="red">
                    {apiErrorMessage(mutation.error)}
                </Text>
            )}
        </Stack>
    );
}

/**
 * How many `card.stage` jobs run at once (card 0115). A save here does not take effect the way
 * `PollerIntervalControl`'s does: pg-boss cannot reconfigure a running worker's concurrency, so the
 * daemon applies a changed value itself, the next time it finds no stage running — see
 * `BoundedCardStageJobRunner` (jobs.module.ts) for why. This control only writes the row and shows
 * what round-tripped; it does not claim the new limit is already in force.
 */
function CardStageConcurrencyControl() {
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: CARD_STAGE_CONCURRENCY_QUERY_KEY, queryFn: () => wilson.settings.getCardStageConcurrency() });
    const [draft, setDraft] = useState<number | ''>('');

    useEffect(() => {
        if (setting.data) setDraft(setting.data.concurrency);
    }, [setting.data]);

    const mutation = useMutation({
        mutationFn: (concurrency: number) => wilson.settings.setCardStageConcurrency({ concurrency }),
        onSuccess: result => {
            queryClient.setQueryData(CARD_STAGE_CONCURRENCY_QUERY_KEY, result);
            setDraft(result.concurrency);
        },
    });

    if (setting.error) {
        return (
            <Alert color="red" title="Cannot load card stage concurrency">
                {apiErrorMessage(setting.error)}
            </Alert>
        );
    }
    if (!setting.data) return <Loader size="sm" />;

    const dirty = draft !== '' && draft !== setting.data.concurrency;

    return (
        <Stack gap="xs">
            <NumberInput
                label="Concurrent stages"
                description="How many card.stage jobs this daemon runs at once. Applies once no stage is currently running — never mid-run."
                value={draft}
                onChange={value => setDraft(value === '' ? '' : Number(value))}
                min={CARD_STAGE_CONCURRENCY_MIN}
                max={CARD_STAGE_CONCURRENCY_MAX}
                disabled={mutation.isPending}
                maw={220}
            />
            <Group gap="xs">
                <Button size="xs" disabled={!dirty || mutation.isPending} onClick={() => dirty && mutation.mutate(draft as number)}>
                    Save
                </Button>
            </Group>
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
 * auto-mode toggle, and the read-only deployment facts above — plus card 0115's two numeric
 * controls. The webhook/base-URL fields are not here yet: that is card [[0116]].
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
                    <Title order={4}>Poll interval</Title>
                    <PollerIntervalControl />
                </Stack>
            </Paper>

            <Paper withBorder p="md" radius="sm">
                <Stack gap="sm">
                    <Title order={4}>Stage concurrency</Title>
                    <CardStageConcurrencyControl />
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
