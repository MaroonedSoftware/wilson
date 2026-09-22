import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActionIcon, Alert, Button, Checkbox, Code, Group, Loader, Modal, NavLink, ScrollArea, Stack, Text, Tooltip } from '@mantine/core';
import { IconArrowUp, IconFolder, IconFolderOpen } from '@tabler/icons-react';
import { reasonFor } from '#src/lib/mutations.js';
import { SdkError, type DirectoryListing } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';

interface DirectoryPickerProps {
    /** Names the field this picks for, in the button's label and the dialog's title. */
    label: string;
    /** The field's current value. Browsing starts here when it is absolute, else at the home folder. */
    value: string;
    onSelect: (path: string) => void;
    disabled?: boolean;
}

/**
 * A folder button for a path field, opening a dialog that browses folders on the daemon's machine
 * (`GET /api/projects/directories`) and fills the field with the one chosen.
 *
 * The browser's own pickers cannot do this: neither `showDirectoryPicker()` nor `webkitdirectory`
 * ever reveals an absolute path, and the path needed is the daemon's anyway. Browsing is confined to
 * the daemon user's home folder by the API, so "Up" disappears there.
 *
 * Starts at the field's current value when that is an absolute path. A proposed worktree or run
 * root usually does not exist yet, so a missing folder opens its nearest existing parent instead
 * (`listNearestExisting`). Any other refusal, such as a path outside the home folder, offers the home
 * folder rather than leaving the dialog stuck on an error.
 */
export function DirectoryPicker({ label, value, onSelect, disabled }: DirectoryPickerProps) {
    const [opened, setOpened] = useState(false);
    const [path, setPath] = useState<string>();
    const [showHidden, setShowHidden] = useState(false);

    const listing = useQuery({
        queryKey: ['directories', path ?? '~'],
        queryFn: () => listNearestExisting(path),
        enabled: opened,
        retry: false,
    });

    const open = () => {
        const start = value.trim();
        setPath(start.startsWith('/') ? start : undefined);
        setOpened(true);
    };

    const select = () => {
        if (!listing.data) return;
        onSelect(listing.data.path);
        setOpened(false);
    };

    const directories = listing.data?.directories.filter(name => showHidden || !name.startsWith('.')) ?? [];

    return (
        <>
            <Tooltip label="Browse">
                <ActionIcon variant="subtle" aria-label={`Browse for ${label.toLowerCase()}`} onClick={open} disabled={disabled}>
                    <IconFolderOpen size={16} />
                </ActionIcon>
            </Tooltip>
            <Modal opened={opened} onClose={() => setOpened(false)} title={`Choose ${label.toLowerCase()}`} size="lg">
                <Stack gap="sm">
                    <Group gap="xs" wrap="nowrap">
                        <Tooltip label="Up one folder">
                            <ActionIcon
                                variant="default"
                                aria-label="Up one folder"
                                disabled={!listing.data?.parent}
                                onClick={() => setPath(listing.data?.parent)}
                            >
                                <IconArrowUp size={16} />
                            </ActionIcon>
                        </Tooltip>
                        <Code style={{ flex: 1, overflowWrap: 'anywhere' }}>{listing.data?.path ?? path ?? '~'}</Code>
                    </Group>

                    {listing.error && (
                        <Alert color="red" title="Cannot open this folder">
                            <Stack gap="xs" align="flex-start">
                                <Text size="sm">{reasonFor(listing.error)}</Text>
                                {path !== undefined && (
                                    <Button size="xs" variant="default" onClick={() => setPath(undefined)}>
                                        Go to the home folder
                                    </Button>
                                )}
                            </Stack>
                        </Alert>
                    )}
                    {listing.isPending && !listing.error && <Loader size="sm" />}
                    {listing.data && (
                        <ScrollArea.Autosize mah={320}>
                            {directories.length === 0 && (
                                <Text size="sm" c="dimmed">
                                    No folders here.
                                </Text>
                            )}
                            <Stack gap={0}>
                                {directories.map(name => (
                                    <NavLink
                                        key={name}
                                        component="button"
                                        label={name}
                                        leftSection={<IconFolder size={16} />}
                                        onClick={() => setPath(`${listing.data.path === '/' ? '' : listing.data.path}/${name}`)}
                                        py={4}
                                    />
                                ))}
                            </Stack>
                        </ScrollArea.Autosize>
                    )}

                    <Group justify="space-between">
                        <Checkbox label="Show hidden folders" size="xs" checked={showHidden} onChange={event => setShowHidden(event.currentTarget.checked)} />
                        <Group gap="xs">
                            <Button variant="default" onClick={() => setOpened(false)}>
                                Cancel
                            </Button>
                            <Button onClick={select} disabled={!listing.data}>
                                Select this folder
                            </Button>
                        </Group>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}

/**
 * Lists `path`, or the closest folder above it that exists when the API answers 404, stopping at
 * `/`. No `path` lists the home folder.
 */
async function listNearestExisting(path: string | undefined): Promise<DirectoryListing> {
    let candidate = path;
    for (;;) {
        try {
            return await wilson.projects.listDirectories(candidate === undefined ? {} : { path: candidate });
        } catch (err) {
            if (!(err instanceof SdkError) || err.status !== 404 || candidate === undefined || candidate === '/') throw err;
            candidate = candidate.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
        }
    }
}
