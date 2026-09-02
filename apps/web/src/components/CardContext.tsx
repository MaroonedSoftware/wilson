import { useState } from 'react';
import { useDisclosure } from '@mantine/hooks';
import { Button, Code, Group, Loader, Modal, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import type { ContextSnapshot } from '@wilson/sdk';
import { formatTimestamp } from '#src/lib/card.js';
import { useAttachContext, useRemoveContext } from '#src/lib/mutations.js';

/**
 * Card 0189: attaches a URL to the card as a context snapshot ([[0187]]'s `POST .../context`) —
 * `RenameControl`'s own shape (`CardEditControls.tsx`, this card's Constraints): `useDisclosure`,
 * the field resets fresh on open, submit disabled while pending, and only a success closes the
 * modal. [[0186]]'s `ContextService` can refuse a URL six ways (a private address, a redirect, a
 * timeout, an oversized body, an upstream error, no provider); `useAttachContext` leaves what was
 * typed in place on any of them, so the field never needs retyping to fix and resend.
 */
function AttachContextControl({ cardId }: { cardId: string }) {
    const [opened, handlers] = useDisclosure(false);
    const [sourceUrl, setSourceUrl] = useState('');
    const attachContext = useAttachContext(cardId);

    const openFresh = () => {
        setSourceUrl('');
        handlers.open();
    };

    const canSubmit = sourceUrl.trim().length > 0 && !attachContext.isPending;

    const submit = () => {
        if (!canSubmit) return;
        attachContext.mutate({ sourceUrl: sourceUrl.trim() }, { onSuccess: () => handlers.close() });
    };

    return (
        <>
            <Button size="xs" variant="light" onClick={openFresh}>
                Attach context
            </Button>
            <Modal opened={opened} onClose={handlers.close} title="Attach context">
                <Stack gap="sm">
                    <TextInput
                        label="Source URL"
                        placeholder="https://…"
                        value={sourceUrl}
                        onChange={event => setSourceUrl(event.currentTarget.value)}
                        disabled={attachContext.isPending}
                        data-autofocus
                    />
                    <Group justify="flex-end">
                        <Button variant="default" onClick={handlers.close} disabled={attachContext.isPending}>
                            Cancel
                        </Button>
                        <Button loading={attachContext.isPending} disabled={!canSubmit} onClick={submit}>
                            Attach
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}

/**
 * Card 0189: removes one snapshot, behind a confirmation modal — this card's Constraints:
 * re-attaching refetches, so removal is recoverable, but a stray click on a destructive action
 * still gets a step to catch it before it lands, a Mantine `Modal` rather than a bare
 * `window.confirm` (`DraftPane.tsx`'s own rule for its save confirmation, followed here for the
 * same reason).
 */
function RemoveContextControl({ cardId, snapshot }: { cardId: string; snapshot: ContextSnapshot }) {
    const [opened, handlers] = useDisclosure(false);
    const removeContext = useRemoveContext(cardId);

    const confirm = () => {
        removeContext.mutate(snapshot.id, { onSuccess: () => handlers.close() });
    };

    return (
        <>
            <Button size="xs" variant="subtle" color="red" onClick={handlers.open}>
                Remove
            </Button>
            <Modal opened={opened} onClose={handlers.close} title="Remove this snapshot?">
                <Stack gap="sm">
                    <Text size="sm">
                        This removes the snapshot fetched from <Code>{snapshot.sourceUrl}</Code>. It can be re-attached later, which fetches it
                        again.
                    </Text>
                    <Group justify="flex-end">
                        <Button variant="default" onClick={handlers.close} disabled={removeContext.isPending}>
                            Cancel
                        </Button>
                        <Button color="red" loading={removeContext.isPending} onClick={confirm}>
                            Remove
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}

/**
 * One attached snapshot: its manifest — source URL, when it was fetched, and by whom (this card's
 * Constraints: "the manifest is the point of the list, not decoration") — plus a title if the fetch
 * found one, so a person can tell one snapshot from another without reading its content. Content
 * itself never renders here: this lists what is attached, not a document viewer (this card's Out
 * of scope; a viewer, if ever wanted, is [[0188]]'s planning agent reading it in full, or its own
 * future card).
 */
function ContextSnapshotItem({ cardId, snapshot }: { cardId: string; snapshot: ContextSnapshot }) {
    return (
        <Paper withBorder p="xs" radius="sm">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={2}>
                    {snapshot.title && (
                        <Text size="sm" fw={500}>
                            {snapshot.title}
                        </Text>
                    )}
                    <Text size="xs" c="dimmed" ff="monospace">
                        {snapshot.sourceUrl}
                    </Text>
                    <Text size="xs" c="dimmed">
                        Fetched {formatTimestamp(snapshot.fetchedAt)} by {snapshot.fetchedBy}
                    </Text>
                </Stack>
                <RemoveContextControl cardId={cardId} snapshot={snapshot} />
            </Group>
        </Paper>
    );
}

/**
 * Card 0189: the operator's surface onto a card's attached context — [[0185]]–[[0188]]'s rows,
 * provider, API and planning-agent read all already exist; this is where a person attaches a
 * document, sees its manifest, and removes one. No optimistic rendering (this card's Constraints):
 * `snapshots` comes straight from the query `ProjectCardDetailRoute` mounts alongside `events` and
 * `versions`, never from what was typed into `AttachContextControl` — a successful attach only
 * invalidates that query (`useAttachContext`, `mutations.ts`), so nothing appears here until the
 * server has actually answered for it.
 */
export function CardContext({
    cardId,
    snapshots,
    error,
}: {
    cardId: string;
    snapshots: ContextSnapshot[] | undefined;
    error: Error | null | undefined;
}) {
    return (
        <Stack gap={6}>
            <Group justify="space-between" align="center">
                <Title order={4}>Context</Title>
                <AttachContextControl cardId={cardId} />
            </Group>
            {error ? (
                <Text size="sm" c="red">
                    Could not load context: {error.message}
                </Text>
            ) : !snapshots ? (
                <Loader size="xs" />
            ) : snapshots.length === 0 ? (
                <Text size="sm" c="dimmed">
                    Nothing attached.
                </Text>
            ) : (
                <Stack gap="xs">
                    {snapshots.map(snapshot => (
                        <ContextSnapshotItem key={snapshot.id} cardId={cardId} snapshot={snapshot} />
                    ))}
                </Stack>
            )}
        </Stack>
    );
}
