import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Checkbox, Code, FileInput, Group, Stack, Text } from '@mantine/core';
import type { App, AppGrant, AppSummary } from '@wilson/sdk';
import { grantableRequests, readAppManifest, type AppGrantRequest, type AppManifest } from '#src/lib/app.manifest.js';
import { addedGrants, APP_GRANTS, grantLabel, MAX_APP_HTML_BYTES, unsupportedApiVersion } from '#src/lib/apps.js';
import { reasonFor } from '#src/lib/mutations.js';
import { AnchorLink } from '#src/lib/router-link.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

const APPS_KEY = ['apps'];

/**
 * What the form holds. A chosen file brings its HTML and manifest. A replace started from an installed app
 * brings that app, and its stored copy once read, so its grants can change without the file to hand.
 */
interface AppForm {
    file: File | null;
    html?: string;
    manifest?: AppManifest;
    /** The installed app this replaces, by the file's id or by its Replace button. */
    target?: AppSummary;
    /** The stored app, read for a replace with no file. */
    stored?: App;
    grants: AppGrant[];
}

const EMPTY_FORM: AppForm = { file: null, grants: [] };

/** A grant to offer, with the app's reason when it gave one. */
interface GrantChoice {
    grant: AppGrant;
    reason?: string;
}

/**
 * What the operator may tick. With a manifest, only what it asks for, each with its reason. An app installed
 * before manifests asked for nothing in particular, so every grant is offered for it, as before.
 */
const choicesFor = (manifest: AppManifest | undefined): GrantChoice[] =>
    manifest
        ? manifest.grants.flatMap(request => {
              const known = APP_GRANTS.find(candidate => candidate.grant === request.grant);
              return known ? [{ grant: known.grant, reason: request.reason }] : [];
          })
        : APP_GRANTS.map(({ grant }) => ({ grant }));

/** The manifest in an app's stored HTML, if it has one. */
const storedManifest = (app: App | undefined): AppManifest | undefined => {
    if (!app) return undefined;
    const reading = readAppManifest(app.html);
    return reading.ok ? reading.manifest : undefined;
};

const versionLabel = (version: string | undefined): string => version ?? 'no version';

/**
 * The settings page's Apps section: installing, replacing and removing operator apps (`apps.ck`).
 * Each of those needs a recent sign-in, and the step-up dialog asks for it when the session is older
 * than five minutes.
 *
 * An app says what it is in a manifest inside its file (`app.manifest.ts`): its id, name, version, the app API
 * version it was written for, and each grant it wants with a reason. The manifest is only a request. Nothing is
 * ticked for a new app, and the operator decides each grant. A file whose id is installed replaces that app, and
 * the form says so, with the versions and any grant it would gain. A replace needs no file: leaving it out
 * changes only the grants, which is how one is taken back without the app's source to hand.
 *
 * An app opens inside a project, so Open shows only when Settings was reached from one.
 */
export function AppsControl({ project }: { project?: string | undefined }) {
    const sdk = useWilsonSdk();
    const queryClient = useQueryClient();
    const apps = useQuery({ queryKey: APPS_KEY, queryFn: () => sdk.apps.listApps() });
    const [form, setForm] = useState<AppForm>(EMPTY_FORM);
    const [removing, setRemoving] = useState<string | undefined>(undefined);
    const [failure, setFailure] = useState<string | undefined>(undefined);

    const installed = apps.data ?? [];
    const manifest = form.manifest ?? storedManifest(form.stored);
    const choices = choicesFor(manifest);
    const unknownRequests: AppGrantRequest[] = manifest?.grants.filter(request => !request.known) ?? [];
    const target = form.target;
    const gaining = target ? addedGrants(target.grants, form.grants) : [];
    const losing = target ? addedGrants(form.grants, target.grants) : [];
    const ready = form.manifest !== undefined || (target !== undefined && form.stored !== undefined);

    const install = useMutation({
        mutationFn: async () => {
            if (form.manifest && form.html !== undefined) {
                const { id, name, description, version, apiVersion } = form.manifest;
                return sdk.apps.installApp(id, {
                    name,
                    ...(description ? { description } : {}),
                    html: form.html,
                    grants: form.grants,
                    version,
                    apiVersion,
                });
            }
            // Without a file the app stays what it was, so only its grants change.
            const kept = form.stored!;
            return sdk.apps.installApp(kept.slug, {
                name: kept.name,
                ...(kept.description ? { description: kept.description } : {}),
                html: kept.html,
                grants: form.grants,
                ...(kept.version ? { version: kept.version } : {}),
                apiVersion: kept.apiVersion,
            });
        },
        onSuccess: () => {
            setForm(EMPTY_FORM);
            void queryClient.invalidateQueries({ queryKey: APPS_KEY });
        },
        onError: err => setFailure(reasonFor(err)),
    });
    const remove = useMutation({
        mutationFn: (slug: string) => sdk.apps.removeApp(slug),
        onSuccess: () => {
            setRemoving(undefined);
            void queryClient.invalidateQueries({ queryKey: APPS_KEY });
        },
        onError: err => setFailure(reasonFor(err)),
    });

    const pickFile = async (file: File | null) => {
        setFailure(undefined);
        if (!file) {
            setForm(current => ({
                ...EMPTY_FORM,
                ...(current.target && current.stored ? { target: current.target, stored: current.stored, grants: current.target.grants } : {}),
            }));
            return;
        }
        if (file.size > MAX_APP_HTML_BYTES) {
            setFailure(`${file.name} is over the ${MAX_APP_HTML_BYTES / 1024} KiB limit.`);
            return;
        }
        const html = await file.text();
        const reading = readAppManifest(html);
        if (!reading.ok) {
            setFailure(`${file.name}: ${reading.reason}`);
            return;
        }
        const next = reading.manifest;
        if (form.target && form.target.slug !== next.id) {
            setFailure(`${file.name} is the app "${next.id}", not ${form.target.name}. Choose its file, or Clear to install it as itself.`);
            return;
        }
        const replacing = installed.find(app => app.slug === next.id);
        const offered = grantableRequests(next);
        setForm({
            file,
            html,
            manifest: next,
            ...(replacing ? { target: replacing } : {}),
            // A new app starts with nothing. A replace keeps what it had, of what the new file still asks for.
            grants: replacing ? replacing.grants.filter(grant => offered.includes(grant)) : [],
        });
    };

    const startReplace = async (app: AppSummary) => {
        setFailure(undefined);
        setForm({ file: null, target: app, grants: app.grants });
        try {
            const stored = await sdk.apps.getApp(app.slug);
            setForm(current => (current.target?.slug === app.slug && !current.file ? { ...current, stored } : current));
        } catch (err) {
            setFailure(reasonFor(err));
        }
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        setFailure(undefined);
        install.mutate();
    };

    const shownName = form.manifest?.name ?? target?.name;
    const unsupported = form.manifest ? unsupportedApiVersion(form.manifest.apiVersion) : undefined;

    return (
        <Stack gap="sm">
            <Text size="sm" c="dimmed">
                An app is one HTML file that runs in its own sandbox, without your credentials and with ordinary web requests blocked. It can read
                only what you tick here, but it could share anything it can read, so install only apps you trust with that data.
            </Text>
            {apps.error && <Alert color="red">{apps.error.message}</Alert>}
            {installed.length === 0 && !apps.isPending && !apps.error && (
                <Text size="sm" c="dimmed">
                    No apps installed.
                </Text>
            )}
            {installed.map(app => (
                <Group key={app.slug} justify="space-between" wrap="nowrap" align="flex-start">
                    <Stack gap={4}>
                        <Group gap="xs">
                            <Text size="sm" fw={500}>
                                {app.name}
                            </Text>
                            <Code>{app.slug}</Code>
                            {app.version && (
                                <Text size="xs" c="dimmed">
                                    {app.version}
                                </Text>
                            )}
                        </Group>
                        {app.description && (
                            <Text size="xs" c="dimmed">
                                {app.description}
                            </Text>
                        )}
                        <Group gap={4}>
                            {app.grants.length === 0 ? (
                                <Text size="xs" c="dimmed">
                                    Reads nothing
                                </Text>
                            ) : (
                                app.grants.map(grant => (
                                    <Badge key={grant} size="xs" variant="light" color="gray">
                                        {grantLabel(grant)}
                                    </Badge>
                                ))
                            )}
                        </Group>
                    </Stack>
                    {removing === app.slug ? (
                        <Group gap="xs" wrap="nowrap">
                            <Button size="xs" color="red" loading={remove.isPending} onClick={() => remove.mutate(app.slug)}>
                                Remove {app.name}
                            </Button>
                            <Button size="xs" variant="subtle" onClick={() => setRemoving(undefined)}>
                                Keep
                            </Button>
                        </Group>
                    ) : (
                        <Group gap="xs" wrap="nowrap">
                            {project && (
                                <AnchorLink to="/projects/$project/apps/$slug" params={{ project, slug: app.slug }} size="sm">
                                    Open
                                </AnchorLink>
                            )}
                            <Button size="xs" variant="default" onClick={() => void startReplace(app)}>
                                Replace
                            </Button>
                            <Button size="xs" variant="subtle" color="red" onClick={() => setRemoving(app.slug)}>
                                Remove
                            </Button>
                        </Group>
                    )}
                </Group>
            ))}
            <form onSubmit={submit}>
                <Stack gap="sm">
                    <FileInput
                        label={target ? 'HTML file (optional, leave empty to change only what it can read)' : 'HTML file'}
                        description="The app's manifest inside it says what it is and what it asks to read"
                        placeholder="Choose a file"
                        accept=".html,.htm,text/html"
                        clearable
                        value={form.file}
                        onChange={file => void pickFile(file)}
                    />
                    {shownName && (
                        <Stack gap={2}>
                            <Group gap="xs">
                                <Text size="sm" fw={500}>
                                    {shownName}
                                </Text>
                                <Code>{form.manifest?.id ?? target?.slug}</Code>
                                {form.manifest && (
                                    <Text size="xs" c="dimmed">
                                        {form.manifest.version}
                                    </Text>
                                )}
                            </Group>
                            {(form.manifest?.description ?? target?.description) && (
                                <Text size="xs" c="dimmed">
                                    {form.manifest?.description ?? target?.description}
                                </Text>
                            )}
                        </Stack>
                    )}
                    {(form.manifest || target) && (
                        <Checkbox.Group
                            label="What it can read"
                            value={form.grants}
                            onChange={grants => setForm({ ...form, grants: grants as AppGrant[] })}
                        >
                            <Stack gap="xs" mt="xs">
                                {choices.length === 0 && (
                                    <Text size="sm" c="dimmed">
                                        It asks to read nothing.
                                    </Text>
                                )}
                                {choices.map(({ grant, reason }) => (
                                    <Checkbox
                                        key={grant}
                                        value={grant}
                                        label={grantLabel(grant)}
                                        description={reason ? `It says: ${reason}` : APP_GRANTS.find(known => known.grant === grant)?.detail}
                                    />
                                ))}
                                {unknownRequests.map(request => (
                                    <Text key={request.grant} size="xs" c="dimmed">
                                        It also asks for {request.grant}, which this Wilson does not have, so it cannot be given.
                                    </Text>
                                ))}
                            </Stack>
                        </Checkbox.Group>
                    )}
                    {unsupported && (
                        <Alert color="yellow" title="This Wilson cannot open it yet">
                            {unsupported}
                        </Alert>
                    )}
                    {target && (
                        <Alert color="yellow" title={`This replaces ${target.name}`}>
                            {form.manifest && <Text size="sm">{`${versionLabel(target.version)} → ${form.manifest.version}`}</Text>}
                            <Text size="sm">
                                {gaining.length > 0
                                    ? `It would gain access to: ${gaining.map(grantLabel).join(', ')}.`
                                    : 'It would gain no new access.'}
                                {losing.length > 0 ? ` It would lose: ${losing.map(grantLabel).join(', ')}.` : ''}
                            </Text>
                        </Alert>
                    )}
                    <Group>
                        <Button type="submit" size="xs" loading={install.isPending} disabled={!ready}>
                            {target ? 'Replace' : 'Install'}
                        </Button>
                        {(form.file || target) && (
                            <Button
                                size="xs"
                                variant="subtle"
                                onClick={() => {
                                    setFailure(undefined);
                                    setForm(EMPTY_FORM);
                                }}
                            >
                                Clear
                            </Button>
                        )}
                    </Group>
                </Stack>
            </form>
            {failure && <Alert color="red">{failure}</Alert>}
        </Stack>
    );
}
