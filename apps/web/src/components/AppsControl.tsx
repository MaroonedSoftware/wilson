import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Checkbox, Code, FileInput, Group, Stack, Text, TextInput } from '@mantine/core';
import type { AppGrant, AppSummary } from '@wilson/sdk';
import { addedGrants, APP_GRANTS, grantLabel, MAX_APP_HTML_BYTES, nameFromFilename, slugFromFilename } from '#src/lib/apps.js';
import { reasonFor } from '#src/lib/mutations.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

const APPS_KEY = ['apps'];

interface AppForm {
    file: File | null;
    slug: string;
    name: string;
    description: string;
    grants: AppGrant[];
}

const EMPTY_FORM: AppForm = { file: null, slug: '', name: '', description: '', grants: [] };

/**
 * The settings page's Apps section: installing, replacing and removing operator apps (`apps.ck`).
 * Each of those needs a recent sign-in, and the step-up dialog asks for it when the session is older
 * than five minutes.
 *
 * An app's HTML says nothing about what it wants, so the operator picks its grants here. Typing the
 * slug of an installed app, or pressing Replace on one, makes the form a replace, which says so and
 * names any grant the app would gain. A replace needs no file: leaving it out changes only the
 * details and grants, which is how a grant is taken back from an app without its source to hand.
 */
export function AppsControl() {
    const sdk = useWilsonSdk();
    const queryClient = useQueryClient();
    const apps = useQuery({ queryKey: APPS_KEY, queryFn: () => sdk.apps.listApps() });
    const [form, setForm] = useState<AppForm>(EMPTY_FORM);
    const [removing, setRemoving] = useState<string | undefined>(undefined);
    const [failure, setFailure] = useState<string | undefined>(undefined);

    const installed = apps.data ?? [];
    const slug = form.slug.trim();
    const existing = installed.find(app => app.slug === slug);
    const gaining = existing ? addedGrants(existing.grants, form.grants) : [];

    const install = useMutation({
        mutationFn: async () => {
            const html = form.file ? await form.file.text() : (await sdk.apps.getApp(slug)).html;
            return sdk.apps.installApp(slug, {
                name: form.name.trim(),
                ...(form.description.trim() ? { description: form.description.trim() } : {}),
                html,
                grants: form.grants,
            });
        },
        onSuccess: () => {
            setForm(EMPTY_FORM);
            void queryClient.invalidateQueries({ queryKey: APPS_KEY });
        },
        onError: err => setFailure(reasonFor(err)),
    });
    const remove = useMutation({
        mutationFn: (target: string) => sdk.apps.removeApp(target),
        onSuccess: () => {
            setRemoving(undefined);
            void queryClient.invalidateQueries({ queryKey: APPS_KEY });
        },
        onError: err => setFailure(reasonFor(err)),
    });

    const pickFile = (file: File | null) => {
        setFailure(undefined);
        if (file && file.size > MAX_APP_HTML_BYTES) {
            setFailure(`${file.name} is over the ${MAX_APP_HTML_BYTES / 1024} KiB limit.`);
            setForm(current => ({ ...current, file: null }));
            return;
        }
        setForm(current => ({
            ...current,
            file,
            slug: current.slug || (file ? slugFromFilename(file.name) : ''),
            name: current.name || (file ? nameFromFilename(file.name) : ''),
        }));
    };

    const startReplace = (app: AppSummary) => {
        setFailure(undefined);
        setForm({ file: null, slug: app.slug, name: app.name, description: app.description, grants: app.grants });
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        setFailure(undefined);
        install.mutate();
    };

    return (
        <Stack gap="sm">
            <Text size="sm" c="dimmed">
                An app is one HTML file that runs in its own sandbox, with no network access and no credentials. It can read only what you tick here,
                but it could share anything it can read, so install only apps you trust with that data.
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
                            <Button size="xs" variant="default" onClick={() => startReplace(app)}>
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
                        label={existing ? 'HTML file (optional, leave empty to keep the current one)' : 'HTML file'}
                        placeholder="Choose a file"
                        accept=".html,.htm,text/html"
                        clearable
                        value={form.file}
                        onChange={pickFile}
                    />
                    <Group grow align="flex-start">
                        <TextInput
                            label="Slug"
                            description="Lowercase letters, digits and hyphens"
                            value={form.slug}
                            onChange={e => setForm({ ...form, slug: e.currentTarget.value })}
                            required
                        />
                        <TextInput
                            label="Name"
                            description="What the app is called in Wilson"
                            value={form.name}
                            onChange={e => setForm({ ...form, name: e.currentTarget.value })}
                            required
                        />
                    </Group>
                    <TextInput
                        label="Description"
                        value={form.description}
                        onChange={e => setForm({ ...form, description: e.currentTarget.value })}
                    />
                    <Checkbox.Group
                        label="What it can read"
                        value={form.grants}
                        onChange={grants => setForm({ ...form, grants: grants as AppGrant[] })}
                    >
                        <Stack gap="xs" mt="xs">
                            {APP_GRANTS.map(({ grant, label, detail }) => (
                                <Checkbox key={grant} value={grant} label={label} description={detail} />
                            ))}
                        </Stack>
                    </Checkbox.Group>
                    {existing && (
                        <Alert color="yellow" title={`This replaces ${existing.name}`}>
                            {gaining.length > 0 ? `It would gain access to: ${gaining.map(grantLabel).join(', ')}.` : 'It would gain no new access.'}
                        </Alert>
                    )}
                    <Group>
                        <Button
                            type="submit"
                            size="xs"
                            loading={install.isPending}
                            disabled={!slug || !form.name.trim() || (!form.file && !existing)}
                        >
                            {existing ? 'Replace' : 'Install'}
                        </Button>
                        {(form.file || form.slug || form.name) && (
                            <Button size="xs" variant="subtle" onClick={() => setForm(EMPTY_FORM)}>
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
