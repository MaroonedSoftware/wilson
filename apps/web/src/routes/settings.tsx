import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Alert,
    Button,
    Code,
    Group,
    Loader,
    NumberInput,
    Paper,
    PasswordInput,
    SegmentedControl,
    Select,
    Stack,
    Switch,
    Text,
    TextInput,
    Title,
} from '@mantine/core';
import type { ChatEngineSetting, EngineTokenSetting, SetNotifyWebhookSettingRequest } from '@wilson/sdk';
import { apiErrorMessage } from '#src/lib/api.error.js';
import { AnchorLink } from '#src/lib/router-link.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';
import { SecurityControls } from '#src/components/SecurityControls.js';

const POLLER_QUERY_KEY = ['settings', 'poller'];
const POLLER_INTERVAL_QUERY_KEY = ['settings', 'poller-interval'];
const CARD_STAGE_CONCURRENCY_QUERY_KEY = ['settings', 'card-stage-concurrency'];
const LOCAL_STAGE_SLOTS_QUERY_KEY = ['settings', 'local-stage-slots'];
const NOTIFY_WEBHOOK_QUERY_KEY = ['settings', 'notify-webhook'];
const CLAUDE_CONFIG_DIR_QUERY_KEY = ['settings', 'claude-config-dir'];
const GITHUB_APP_QUERY_KEY = ['settings', 'github-app'];
const ENGINE_TOKEN_QUERY_KEY = ['settings', 'engine-token'];
const ENGINE_TOKENS_QUERY_KEY = ['engine-tokens'];
const CHAT_ENGINE_QUERY_KEY = ['settings', 'chat-engine'];

// Display-only hints for the `NumberInput`s below — clamping here is a convenience, not
// enforcement. The API refuses out of range regardless of what these let a user type up to
// (`job.runner.config.ts` carries the real bounds and the reasoning); a stale hint here would only
// ever make the control feel wrong, never make an out-of-range value reach the server unrefused.
const POLLER_INTERVAL_MIN_MS = 5_000;
const POLLER_INTERVAL_MAX_MS = 300_000;
const CARD_STAGE_CONCURRENCY_MIN = 1;
const CARD_STAGE_CONCURRENCY_MAX = 32;
const LOCAL_STAGE_SLOTS_MIN = 1;
const LOCAL_STAGE_SLOTS_MAX = 8;

/**
 * The one control this card adds: `POLLER_ENABLED`, readable and settable at runtime (card 0106).
 * Renders whatever `setPollerSetting` hands back rather than the value clicked — a write the server
 * refuses must not show as applied, so the query cache only ever holds a value that round-tripped.
 */
function AutoModeToggle() {
    const wilson = useWilsonSdk();
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
    const wilson = useWilsonSdk();
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
        // A refusal must not leave the rejected draft on screen — revert to the setting's own
        // current value, the same "only ever show what round-tripped" rule the query cache follows.
        onError: () => {
            if (setting.data) setDraft(setting.data.intervalMs);
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
    const wilson = useWilsonSdk();
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
        // A refusal must not leave the rejected draft on screen — revert to the setting's own
        // current value, the same "only ever show what round-tripped" rule the query cache follows.
        onError: () => {
            if (setting.data) setDraft(setting.data.concurrency);
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
                description="How many card.stage jobs run at once, on this machine and every registered host together. Applies once no stage is currently running — never mid-run."
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

/**
 * How many stages may hold a worktree on this machine at once (`local-stage-slots`), out of
 * `CardStageConcurrencyControl`'s total across this machine and every registered host. Read on every
 * dispatch, so unlike the total it applies to the next stage with nothing to wait for.
 */
function LocalStageSlotsControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: LOCAL_STAGE_SLOTS_QUERY_KEY, queryFn: () => wilson.settings.getLocalStageSlots() });
    const [draft, setDraft] = useState<number | ''>('');

    useEffect(() => {
        if (setting.data) setDraft(setting.data.slots);
    }, [setting.data]);

    const mutation = useMutation({
        mutationFn: (slots: number) => wilson.settings.setLocalStageSlots({ slots }),
        onSuccess: result => {
            queryClient.setQueryData(LOCAL_STAGE_SLOTS_QUERY_KEY, result);
            setDraft(result.slots);
        },
        // A refusal must not leave the rejected draft on screen — revert to the setting's own
        // current value, the same "only ever show what round-tripped" rule the query cache follows.
        onError: () => {
            if (setting.data) setDraft(setting.data.slots);
        },
    });

    if (setting.error) {
        return (
            <Alert color="red" title="Cannot load local stage slots">
                {apiErrorMessage(setting.error)}
            </Alert>
        );
    }
    if (!setting.data) return <Loader size="sm" />;

    const dirty = draft !== '' && draft !== setting.data.slots;

    return (
        <Stack gap="xs">
            <NumberInput
                label="Stages on this machine"
                description="How many stages may hold a worktree here at once, out of the total above. Applies to the next stage."
                value={draft}
                onChange={value => setDraft(value === '' ? '' : Number(value))}
                min={LOCAL_STAGE_SLOTS_MIN}
                max={LOCAL_STAGE_SLOTS_MAX}
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
 * The webhook destination and its companion base URL (card 0107, UI here per card 0116). One
 * `Paper`/one form, not two, because the API is one resource with one `PUT` — `Notifier.notify`
 * always reads both together (`settings.ck`'s own comment: a base URL with nothing to post it to is
 * exactly as useless as a webhook with no way to name the card in its payload).
 *
 * The two fields are not the same kind of risk and must not read as if they were:
 * - `webhookUrl` is a destination this daemon POSTs to. `NotifyWebhookSettingService.set` runs
 *   `checkWebhookDestination` against it (https only, no loopback/link-local/private/unspecified
 *   address, checked again on every send) and refuses anything that fails with the specific rule
 *   and resolved address it broke — that sentence is rendered verbatim below, not replaced with a
 *   generic "invalid URL", because an operator has no other way to see the server's own DNS
 *   resolution.
 * - `baseUrl` is a link included inside the notification payload. Nothing here ever fetches it, so
 *   it carries none of `webhookUrl`'s checks and is saved exactly as typed — the description next to
 *   it says so, rather than letting a shared "Save" button imply a shared guarantee.
 *
 * Unlike `PollerIntervalControl`/`CardStageConcurrencyControl`, a refusal does not revert the typed
 * draft back to the stored value — this field is fiddly enough that discarding a rejected attempt
 * would force retyping it blind. Instead the draft is left exactly as typed, and the still-current
 * stored value is shown alongside the server's refusal so neither the attempt nor the actual state
 * is lost.
 *
 * Client-side format checking is deliberately absent (card 0116's own constraint): a browser-side
 * URL check that disagreed with `checkWebhookDestination`'s DNS-resolution-based rules would be
 * worse than no check at all. The server is the only boundary that matters here.
 *
 * Note for whoever reads the result of this card: this puts an outbound POST destination behind a
 * browser form with no authentication (card 0019 is not built). `checkWebhookDestination` narrows
 * *where* it can be pointed; it does not stop an unauthenticated caller reaching this page or this
 * endpoint directly and pointing it somewhere the check still permits.
 */
function NotifyWebhookControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: NOTIFY_WEBHOOK_QUERY_KEY, queryFn: () => wilson.settings.getNotifyWebhookSetting() });
    const [webhookDraft, setWebhookDraft] = useState('');
    const [baseUrlDraft, setBaseUrlDraft] = useState('');

    useEffect(() => {
        if (setting.data) {
            setWebhookDraft(setting.data.webhookUrl ?? '');
            setBaseUrlDraft(setting.data.baseUrl ?? '');
        }
    }, [setting.data]);

    const mutation = useMutation({
        mutationFn: (body: SetNotifyWebhookSettingRequest) => wilson.settings.setNotifyWebhookSetting(body),
        onSuccess: result => {
            queryClient.setQueryData(NOTIFY_WEBHOOK_QUERY_KEY, result);
            setWebhookDraft(result.webhookUrl ?? '');
            setBaseUrlDraft(result.baseUrl ?? '');
        },
        // Deliberately no onError revert here — see the component doc above.
    });

    if (setting.error) {
        return (
            <Alert color="red" title="Cannot load notification URLs">
                {apiErrorMessage(setting.error)}
            </Alert>
        );
    }
    if (!setting.data) return <Loader size="sm" />;

    const dirty = webhookDraft !== (setting.data.webhookUrl ?? '') || baseUrlDraft !== (setting.data.baseUrl ?? '');
    const save = () => {
        mutation.mutate({
            webhookUrl: webhookDraft.trim() === '' ? null : webhookDraft.trim(),
            baseUrl: baseUrlDraft.trim() === '' ? null : baseUrlDraft.trim(),
        });
    };

    return (
        <Stack gap="sm">
            <Text size="sm" c="dimmed">
                These carry different risk. The webhook URL is a destination this daemon sends a request to, so the server checks it — https only, and
                not an address that resolves somewhere private — both when it is saved and again every time it is used, and refuses anything that
                fails. The base URL only appears as a link inside that request's payload; nothing here ever fetches it, so it is saved exactly as
                typed.
            </Text>
            <TextInput
                label="Webhook URL"
                description="Where notifications are sent. Checked by the server on save and on every use; a refused value is never stored."
                placeholder="https://example.com/hook"
                value={webhookDraft}
                onChange={event => setWebhookDraft(event.currentTarget.value)}
                disabled={mutation.isPending}
            />
            <TextInput
                label="Base URL"
                description="A link back to this board, included in the notification payload. Not validated — it is never a destination this daemon contacts."
                placeholder="https://board.example"
                value={baseUrlDraft}
                onChange={event => setBaseUrlDraft(event.currentTarget.value)}
                disabled={mutation.isPending}
            />
            <Group gap="xs">
                <Button size="xs" disabled={!dirty || mutation.isPending} onClick={save}>
                    Save
                </Button>
            </Group>
            {mutation.isError && (
                <Stack gap={2}>
                    <Text size="sm" c="red">
                        {apiErrorMessage(mutation.error)}
                    </Text>
                    <Text size="xs" c="dimmed">
                        Still saved: {setting.data.webhookUrl ?? 'not set'}
                    </Text>
                </Stack>
            )}
        </Stack>
    );
}

/**
 * The engine's Claude config directory (card 0141) — which Claude Code credentials the `cli`
 * adapter's engine (`scope-check`, `implementing`, `testing`, `review`, and the planning session)
 * authenticates with, instead of silently inheriting whatever lives in the daemon user's own
 * `~/.claude`.
 *
 * This is the one setting on this page whose wrong value stops the runner dead: point it somewhere
 * unauthenticated and every `cli`-adapter model call fails. The description below says so plainly,
 * and says a change only reaches stages started after the save — the concurrency control
 * (`CardStageConcurrencyControl` above) is the wording this borrows.
 *
 * A refusal does not revert the typed draft, the same choice `NotifyWebhookControl` makes and for
 * the same reason: an absolute path typo is easy to mistype twice in a row, and discarding the
 * attempt would force retyping it blind.
 */
function ClaudeConfigDirControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: CLAUDE_CONFIG_DIR_QUERY_KEY, queryFn: () => wilson.settings.getClaudeConfigDirSetting() });
    const [draft, setDraft] = useState('');

    useEffect(() => {
        if (setting.data) setDraft(setting.data.configDir ?? '');
    }, [setting.data]);

    const mutation = useMutation({
        mutationFn: (configDir: string | null) => wilson.settings.setClaudeConfigDirSetting({ configDir }),
        onSuccess: result => {
            queryClient.setQueryData(CLAUDE_CONFIG_DIR_QUERY_KEY, result);
            setDraft(result.configDir ?? '');
        },
        // Deliberately no onError revert here — see the component doc above.
    });

    if (setting.error) {
        return (
            <Alert color="red" title="Cannot load claude config directory">
                {apiErrorMessage(setting.error)}
            </Alert>
        );
    }
    if (!setting.data) return <Loader size="sm" />;

    const dirty = draft !== (setting.data.configDir ?? '');

    return (
        <Stack gap="xs">
            <TextInput
                label="Claude config directory"
                description="Where the engine reads its Claude Code credentials from. Must already be authenticated — pointing this at an unauthenticated directory fails every cli-adapter stage at the model call. Leave empty to use the daemon's own default. A change applies to stages started afterwards, never one already running."
                placeholder="/home/operator/.claude-wilson"
                value={draft}
                onChange={event => setDraft(event.currentTarget.value)}
                disabled={mutation.isPending}
            />
            <Group gap="xs">
                <Button
                    size="xs"
                    disabled={!dirty || mutation.isPending}
                    onClick={() => dirty && mutation.mutate(draft.trim() === '' ? null : draft.trim())}
                >
                    Save
                </Button>
            </Group>
            {mutation.isError && (
                <Stack gap={2}>
                    <Text size="sm" c="red">
                        {apiErrorMessage(mutation.error)}
                    </Text>
                    <Text size="xs" c="dimmed">
                        Still saved: {setting.data.configDir ?? 'not set'}
                    </Text>
                </Stack>
            )}
        </Stack>
    );
}

/**
 * The GitHub App's id, and whether its private key is in place. The key is never entered here: it
 * goes in a file on the daemon's machine, so this only reports it. A refusal keeps the draft, the
 * same choice `ClaudeConfigDirControl` makes.
 */
function GitHubAppControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: GITHUB_APP_QUERY_KEY, queryFn: () => wilson.settings.getGithubAppSetting() });
    const [draft, setDraft] = useState('');

    useEffect(() => {
        if (setting.data) setDraft(setting.data.appId ?? '');
    }, [setting.data]);

    const mutation = useMutation({
        mutationFn: (appId: string | null) => wilson.settings.setGithubAppSetting({ appId }),
        onSuccess: result => {
            queryClient.setQueryData(GITHUB_APP_QUERY_KEY, result);
            setDraft(result.appId ?? '');
        },
    });

    if (setting.error) {
        return (
            <Alert color="red" title="Cannot load GitHub App">
                {apiErrorMessage(setting.error)}
            </Alert>
        );
    }
    if (!setting.data) return <Loader size="sm" />;

    const dirty = draft !== (setting.data.appId ?? '');

    return (
        <Stack gap="xs">
            <TextInput
                label="GitHub App ID"
                description="Lets Wilson clone repositories when adding a project. Shown on the app's settings page on GitHub. Takes effect without a restart."
                placeholder="123456"
                value={draft}
                onChange={event => setDraft(event.currentTarget.value)}
                disabled={mutation.isPending}
            />
            <Text size="sm" c={setting.data.keyInstalled ? 'dimmed' : 'orange'}>
                {setting.data.keyInstalled
                    ? 'Private key found.'
                    : 'Private key not found. Put it at secrets/github-app.pem in the data folder on the machine Wilson runs on.'}
            </Text>
            <Group gap="xs">
                <Button
                    size="xs"
                    disabled={!dirty || mutation.isPending}
                    onClick={() => dirty && mutation.mutate(draft.trim() === '' ? null : draft.trim())}
                >
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

const ENGINE_TOKEN_SOURCES: Record<EngineTokenSetting['source'], string> = {
    database: 'Engines on this machine sign in with the token saved here.',
    environment: 'Engines on this machine sign in with CLAUDE_CODE_OAUTH_TOKEN from the environment. A token saved here replaces it.',
    none: 'No token is set, so engines on this machine use the login in their Claude config directory.',
};

/**
 * The engine token (`EngineTokenSettingService`). Write-only: the API reports where the sign-in comes
 * from and never the token, so the field starts empty, and is emptied again after a save.
 *
 * A refusal keeps the draft, the same choice `ClaudeConfigDirControl` makes.
 */
function EngineTokenControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: ENGINE_TOKEN_QUERY_KEY, queryFn: () => wilson.settings.getEngineTokenSetting() });
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

    return (
        <Stack gap="xs">
            <PasswordInput
                label="Engine token"
                description="What engines on this machine sign in with, ahead of the config directory above. Make one with claude setup-token. Worker hosts use the tokens below, and SSH hosts their own. A change applies to stages and planning sessions started afterwards, never one already running."
                value={draft}
                onChange={event => setDraft(event.currentTarget.value)}
                disabled={mutation.isPending}
                autoComplete="off"
            />
            <Text size="sm">{ENGINE_TOKEN_SOURCES[setting.data.source]}</Text>
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
            {mutation.isError && (
                <Text size="sm" c="red">
                    {apiErrorMessage(mutation.error)}
                </Text>
            )}
        </Stack>
    );
}

/**
 * The named engine tokens worker hosts are assigned (`EngineTokensService`), on the Hosts page. Write
 * only, as {@link EngineTokenControl} is: the list has names and no token, and the fields start empty.
 * Saving under a name already there replaces that token and no other.
 */
function WorkerEngineTokensControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const tokens = useQuery({ queryKey: ENGINE_TOKENS_QUERY_KEY, queryFn: () => wilson.engineTokens.listEngineTokens() });
    const [name, setName] = useState('');
    const [token, setToken] = useState('');

    const refresh = () => queryClient.invalidateQueries({ queryKey: ENGINE_TOKENS_QUERY_KEY });
    const put = useMutation({
        mutationFn: () => wilson.engineTokens.putEngineToken(name.trim(), { token }),
        onSuccess: () => {
            setName('');
            setToken('');
            return refresh();
        },
    });
    const remove = useMutation({ mutationFn: (saved: string) => wilson.engineTokens.removeEngineToken(saved), onSuccess: refresh });

    if (tokens.error) {
        return (
            <Alert color="red" title="Cannot load the worker engine tokens">
                {apiErrorMessage(tokens.error)}
            </Alert>
        );
    }
    if (!tokens.data) return <Loader size="sm" />;

    const failed = [put, remove].find(mutation => mutation.isError);
    return (
        <Stack gap="xs">
            <Text size="sm" fw={500}>
                Worker engine tokens
            </Text>
            <Text size="xs" c="dimmed">
                Tokens Wilson holds for worker hosts, each assigned on the Hosts page. Wilson sends one to its worker with each engine start, and a
                stage there can read it. Saving under an existing name replaces that token. Removing one sends its hosts back to their own sign-in,
                leaves running engines alone, and does not revoke it with Anthropic.
            </Text>
            {tokens.data.map(saved => (
                <Group key={saved.name} gap="xs">
                    <Text size="sm">{saved.name}</Text>
                    <Text size="sm" c="dimmed">
                        {saved.hosts.length > 0 ? saved.hosts.join(', ') : 'no host'}
                    </Text>
                    <Button size="compact-xs" variant="subtle" color="red" disabled={remove.isPending} onClick={() => remove.mutate(saved.name)}>
                        Remove
                    </Button>
                </Group>
            ))}
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
 * Which engine the chat runs on (`chat.engine.setting.ts`): 'cli', the Claude Agent SDK on the
 * subscription the stages use, or 'api', the AI SDK against a provider's API key. The provider
 * matters only for 'api'. A local draft and an explicit Save, like `ClaudeConfigDirControl`, so
 * typing a model name sends nothing until it is saved; what is shown after a save is what the server
 * kept.
 */
function ChatEngineControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: CHAT_ENGINE_QUERY_KEY, queryFn: () => wilson.settings.getChatEngineSetting() });
    const [draft, setDraft] = useState<ChatEngineSetting | undefined>(undefined);

    useEffect(() => {
        if (setting.data) setDraft(setting.data);
    }, [setting.data]);

    const mutation = useMutation({
        mutationFn: (choice: ChatEngineSetting) => wilson.settings.setChatEngineSetting(choice),
        onSuccess: result => {
            queryClient.setQueryData(CHAT_ENGINE_QUERY_KEY, result);
            setDraft(result);
        },
    });

    if (setting.error) {
        return (
            <Alert color="red" title="Cannot load the chat engine">
                {apiErrorMessage(setting.error)}
            </Alert>
        );
    }
    if (!setting.data || !draft) return <Loader size="sm" />;

    const dirty = draft.engine !== setting.data.engine || draft.provider !== setting.data.provider || draft.model !== setting.data.model;

    return (
        <Stack gap="xs">
            <SegmentedControl
                aria-label="Chat engine"
                value={draft.engine}
                onChange={engine => setDraft({ ...draft, engine: engine as ChatEngineSetting['engine'] })}
                disabled={mutation.isPending}
                data={[
                    { value: 'cli', label: 'Claude Agent SDK' },
                    { value: 'api', label: 'AI SDK' },
                ]}
            />
            <Text size="xs" c="dimmed">
                {draft.engine === 'cli'
                    ? 'Runs on the Claude subscription the stages use, from the engine credentials below. No API key needed.'
                    : "Runs against the provider's API key in apps/api/.env, billed per token."}{' '}
                Applies to chats started afterwards; a chat keeps the engine it started on.
            </Text>
            {draft.engine === 'api' && (
                <Select
                    label="Provider"
                    value={draft.provider}
                    onChange={provider => provider && setDraft({ ...draft, provider: provider as ChatEngineSetting['provider'] })}
                    data={['anthropic', 'openai', 'xai']}
                    allowDeselect={false}
                    disabled={mutation.isPending}
                />
            )}
            <TextInput
                label="Model"
                value={draft.model}
                onChange={event => setDraft({ ...draft, model: event.currentTarget.value })}
                disabled={mutation.isPending}
            />
            <Group gap="xs">
                <Button size="xs" disabled={!dirty || mutation.isPending} onClick={() => dirty && mutation.mutate(draft)}>
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
 * What this process is and where it runs. `codeRoot` and `worktreeRoot` are
 * deployment topology (card 0106's rule, extended to this endpoint by card 0114) — shown greyed,
 * with a line saying why, rather than left for an operator to go hunting for an edit control that
 * does not exist.
 */
function DeploymentFacts() {
    const wilson = useWilsonSdk();
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
            <Fact label="Started">{health.data.startedAt.toJSDate().toLocaleString()}</Fact>
            <Fact label="Code root" muted>
                {health.data.codeRoot}
            </Fact>
            <Fact label="Worktree root" muted>
                {health.data.worktreeRoot}
            </Fact>
            <Text size="xs" c="dimmed">
                Code and worktree roots are environment-only — set at deploy time, not editable here. Changing them out from under a running daemon is
                a redeploy, not a setting.
            </Text>
        </Stack>
    );
}

/**
 * Settings: card 0114's slice of what card 0106 put behind the API — the page itself, the
 * auto-mode toggle, and the read-only deployment facts above — plus card 0115's two numeric
 * controls, card 0116's webhook/base-URL fields, and card 0141's claude config directory field.
 *
 * Card 0155: `/settings` stays a top-level route (this card's Constraints), so "back to the board"
 * has no route param to read the way a `/projects/$project/*` screen's own back-link does. The header
 * link names the project it was clicked from in `?project=` instead, so the link returns to that
 * board rather than the deployment's default project. Arriving from anywhere else there is no board
 * to return to, so it goes to the projects list.
 */
function SettingsRoute() {
    const { project } = Route.useSearch();

    return (
        <Stack gap="lg">
            {project ? (
                <AnchorLink to="/projects/$project" params={{ project }} size="sm">
                    ← Back to the board
                </AnchorLink>
            ) : (
                <AnchorLink to="/projects" size="sm">
                    ← Back to projects
                </AnchorLink>
            )}
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
                    <LocalStageSlotsControl />
                </Stack>
            </Paper>

            <Paper withBorder p="md" radius="sm">
                <Stack gap="sm">
                    <Title order={4}>Notifications</Title>
                    <NotifyWebhookControl />
                </Stack>
            </Paper>

            <Paper withBorder p="md" radius="sm">
                <Stack gap="sm">
                    <Title order={4}>Engine credentials</Title>
                    <ClaudeConfigDirControl />
                    <EngineTokenControl />
                    <WorkerEngineTokensControl />
                </Stack>
            </Paper>

            <Paper withBorder p="md" radius="sm">
                <Stack gap="sm">
                    <Title order={4}>GitHub</Title>
                    <GitHubAppControl />
                </Stack>
            </Paper>

            <Paper withBorder p="md" radius="sm">
                <Stack gap="sm">
                    <Title order={4}>Chat</Title>
                    <ChatEngineControl />
                </Stack>
            </Paper>

            <Paper withBorder p="md" radius="sm">
                <Stack gap="sm">
                    <Title order={4}>Security</Title>
                    <SecurityControls />
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

export const Route = createFileRoute('/settings')({
    validateSearch: (search: Record<string, unknown>): { project?: string } =>
        typeof search.project === 'string' ? { project: search.project } : {},
    component: SettingsRoute,
});
