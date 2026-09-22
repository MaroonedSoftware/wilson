import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useDisclosure } from '@mantine/hooks';
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { CreateProjectRequest } from '@wilson/sdk';
import { DirectoryPicker } from '#src/components/DirectoryPicker.js';
import { reasonFor } from '#src/lib/mutations.js';
import { defaultProjectPaths } from '#src/lib/projects.js';
import { wilson, wilsonForProject } from '#src/lib/sdk.js';

/** A failed submit, naming which of the two writes it stopped at and the API's own reason. */
class CreateProjectError extends Error {
    constructor(
        readonly step: 'register' | 'initialise',
        cause: unknown,
    ) {
        super(reasonFor(cause), { cause });
    }
}

/**
 * The dashboard's control for adding a project: `wilson project create` and `wilson board init` in
 * one form, so a new board is ready for cards without a shell.
 *
 * Two writes, in order: `POST /api/projects` registers the row, then `POST /api/board/init` (through
 * `wilsonForProject`, so `X-Wilson-Project` names the new project) gives it its first stage config.
 * They are not one transaction. If registering succeeds and initialising fails, the project exists
 * with no stage config, and a plain retry would hit the API's 409 for a taken name. So the name that
 * registered is remembered, and a retry for that same name goes straight to initialising.
 *
 * Each path field has a folder button (`DirectoryPicker`) that browses the daemon's machine, since a
 * browser's own picker never reveals an absolute path. The worktree and run roots follow the code
 * root (`defaultProjectPaths`) until someone types or picks into either field; from then on that
 * field is theirs. Every path still goes to the API as typed, and
 * the API's own refusals (a relative path, a taken name) are shown inline with the form left intact.
 *
 * On success the registered-projects cache (`['registered-projects']`, shared with the dashboard and
 * `ProjectSwitcher`) is invalidated and the browser goes to the new project's board.
 */
export function NewProjectControl() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [opened, handlers] = useDisclosure(false);
    const [name, setName] = useState('');
    const [codeRoot, setCodeRoot] = useState('');
    const [worktreeRoot, setWorktreeRoot] = useState<string>();
    const [runRoot, setRunRoot] = useState<string>();
    const [registeredName, setRegisteredName] = useState<string>();
    const [failure, setFailure] = useState<CreateProjectError>();

    const defaults = defaultProjectPaths(name, codeRoot);
    const request: CreateProjectRequest = {
        name: name.trim(),
        codeRoot: codeRoot.trim(),
        worktreeRoot: (worktreeRoot ?? defaults.worktreeRoot).trim(),
        runRoot: (runRoot ?? defaults.runRoot).trim(),
    };

    const reset = () => {
        setName('');
        setCodeRoot('');
        setWorktreeRoot(undefined);
        setRunRoot(undefined);
        setRegisteredName(undefined);
        setFailure(undefined);
    };

    const create = useMutation({
        mutationFn: async (body: CreateProjectRequest) => {
            if (registeredName !== body.name) {
                try {
                    await wilson.projects.registerProject(body);
                } catch (err) {
                    throw new CreateProjectError('register', err);
                }
                setRegisteredName(body.name);
                // Listed from here on, even if initialising fails and the modal is closed.
                void queryClient.invalidateQueries({ queryKey: ['registered-projects'] });
            }
            try {
                await wilsonForProject(body.name).board.initialiseBoard();
            } catch (err) {
                throw new CreateProjectError('initialise', err);
            }
            return body.name;
        },
        onMutate: () => setFailure(undefined),
        onError: err => setFailure(err instanceof CreateProjectError ? err : new CreateProjectError('register', err)),
        onSuccess: project => {
            void queryClient.invalidateQueries({ queryKey: ['registered-projects'] });
            handlers.close();
            reset();
            void navigate({ to: '/projects/$project', params: { project } });
        },
    });

    // Picking the repo usually names the project too, so an empty name takes the folder's.
    const pickCodeRoot = (path: string) => {
        setCodeRoot(path);
        if (!name.trim()) setName(path.slice(path.lastIndexOf('/') + 1));
    };

    const openFresh = () => {
        reset();
        handlers.open();
    };

    const canSubmit = Object.values(request).every(value => value.length > 0) && !create.isPending;

    const submit = () => {
        if (canSubmit) create.mutate(request);
    };

    return (
        <>
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={openFresh}>
                New project
            </Button>
            <Modal opened={opened} onClose={handlers.close} title="Add a project" size="lg">
                <Stack gap="sm">
                    <Text size="sm" c="dimmed">
                        Registers the repo and gives its board the default stage config, same as <code>wilson project create</code>{' '}
                        followed by <code>wilson board init</code>. All paths are on the machine the daemon runs on.
                    </Text>
                    <TextInput
                        label="Name"
                        value={name}
                        onChange={event => setName(event.currentTarget.value)}
                        disabled={create.isPending}
                        data-autofocus
                    />
                    <TextInput
                        label="Code root"
                        description="Absolute path to the git repo agents work in."
                        placeholder="/Users/you/projects/myapp"
                        value={codeRoot}
                        onChange={event => setCodeRoot(event.currentTarget.value)}
                        disabled={create.isPending}
                        rightSection={<DirectoryPicker label="Code root" value={codeRoot} onSelect={pickCodeRoot} disabled={create.isPending} />}
                    />
                    <TextInput
                        label="Worktree root"
                        description="Where each card's worktree is cut."
                        value={worktreeRoot ?? defaults.worktreeRoot}
                        onChange={event => setWorktreeRoot(event.currentTarget.value)}
                        disabled={create.isPending}
                        rightSection={
                            <DirectoryPicker label="Worktree root" value={worktreeRoot ?? defaults.worktreeRoot} onSelect={setWorktreeRoot} disabled={create.isPending} />
                        }
                    />
                    <TextInput
                        label="Run root"
                        description="Where per-card run state is kept."
                        value={runRoot ?? defaults.runRoot}
                        onChange={event => setRunRoot(event.currentTarget.value)}
                        disabled={create.isPending}
                        rightSection={<DirectoryPicker label="Run root" value={runRoot ?? defaults.runRoot} onSelect={setRunRoot} disabled={create.isPending} />}
                    />
                    {failure && (
                        <Alert color="red" title={failure.step === 'register' ? 'Could not register the project' : 'Registered, but could not initialise its board'}>
                            {failure.message}
                            {failure.step === 'initialise' && ' Submitting again only retries initialising the board.'}
                        </Alert>
                    )}
                    <Group justify="flex-end">
                        <Button variant="default" onClick={handlers.close} disabled={create.isPending}>
                            Cancel
                        </Button>
                        <Button loading={create.isPending} disabled={!canSubmit} onClick={submit}>
                            Create
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}
