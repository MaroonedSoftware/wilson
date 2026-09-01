import { useState } from 'react';
import { useDisclosure } from '@mantine/hooks';
import { ActionIcon, Button, Code, Group, Modal, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import type { CardDetail } from '@wilson/sdk';
import { useEditCardBody, useRenameCard, useSetCardDependency } from '#src/lib/mutations.js';

/**
 * Card 0177: a pencil `ActionIcon` beside the card's `Title` (`CardDetail.tsx`'s header) that opens
 * a modal seeded with `card.title` — `NewCardControl.tsx`'s own shape (`useDisclosure`, fields reset
 * fresh on open, submit disabled while pending). A refusal (`useRenameCard`) is a red notification
 * naming the server's own reason and, since `useMutation` leaves `title` untouched on error, the
 * modal stays open with what was typed still there to fix and resend — nothing here clears it.
 * Only a successful rename closes the modal; the new title itself reaches the header from the
 * mutation's own cache write (`mutations.ts`'s `useRenameCard`), never from what was typed.
 */
export function RenameControl({ card }: { card: CardDetail }) {
    const [opened, handlers] = useDisclosure(false);
    const [title, setTitle] = useState(card.title);
    const renameCard = useRenameCard(card.id);

    const openFresh = () => {
        setTitle(card.title);
        handlers.open();
    };

    const canSubmit = title.trim().length > 0 && !renameCard.isPending;

    const submit = () => {
        if (!canSubmit) return;
        renameCard.mutate(title.trim(), { onSuccess: () => handlers.close() });
    };

    return (
        <>
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Rename card" onClick={openFresh}>
                <IconPencil size={14} />
            </ActionIcon>
            <Modal opened={opened} onClose={handlers.close} title="Rename card">
                <Stack gap="sm">
                    <TextInput
                        label="Title"
                        value={title}
                        onChange={event => setTitle(event.currentTarget.value)}
                        disabled={renameCard.isPending}
                        data-autofocus
                    />
                    <Group justify="flex-end">
                        <Button variant="default" onClick={handlers.close} disabled={renameCard.isPending}>
                            Cancel
                        </Button>
                        <Button loading={renameCard.isPending} disabled={!canSubmit} onClick={submit}>
                            Rename
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}

/**
 * Card 0177: the button beside the "Plan" heading that opens a body-only editor — only ever
 * rendered by `CardDetail.tsx`'s non-planning branch, since `planning`/`parking-lot` already get
 * `DraftPane`'s session editor (cards 0138/0159) and this control must not offer a second door onto
 * the same draft (this card's Constraints). Same `NewCardControl.tsx` shape as `RenameControl`
 * above: an autosized monospace `Textarea` seeded with `card.body`, a refusal (`useEditCardBody`)
 * left as a red notification with the typed body untouched for retry, and only a success closes the
 * modal — the body shown afterward comes from the mutation's own cache write, never an echo of what
 * was typed.
 */
export function EditBodyControl({ card }: { card: CardDetail }) {
    const [opened, handlers] = useDisclosure(false);
    const [body, setBody] = useState(card.body);
    const editCardBody = useEditCardBody(card.id);

    const openFresh = () => {
        setBody(card.body);
        handlers.open();
    };

    const canSubmit = body.trim().length > 0 && !editCardBody.isPending;

    const submit = () => {
        if (!canSubmit) return;
        editCardBody.mutate(body, { onSuccess: () => handlers.close() });
    };

    return (
        <>
            <Button size="xs" variant="subtle" onClick={openFresh}>
                Edit body
            </Button>
            <Modal opened={opened} onClose={handlers.close} title="Edit card body" size="lg">
                <Stack gap="sm">
                    <Textarea
                        label="Body"
                        value={body}
                        onChange={event => setBody(event.currentTarget.value)}
                        autosize
                        minRows={12}
                        disabled={editCardBody.isPending}
                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                        data-autofocus
                    />
                    <Group justify="flex-end">
                        <Button variant="default" onClick={handlers.close} disabled={editCardBody.isPending}>
                            Cancel
                        </Button>
                        <Button loading={editCardBody.isPending} disabled={!canSubmit} onClick={submit}>
                            Save
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}

/**
 * Card 0177: renders `card.dependsOn` with a per-id remove button, plus a plain `TextInput` to add
 * one by id (this card's Constraints: a picker fed by the cards list, and cycle detection, are both
 * explicitly out of scope — the server refuses an unknown id with a reason the same way it refuses a
 * cycle). Both add and remove go through `useSetCardDependency` (`mutations.ts`), whose refusal is a
 * red notification naming the server's own reason — this file's default, not the inline-error
 * pattern the plan composer uses, since there is no in-progress conversation here to protect. The
 * typed id is only cleared on a successful add, so a refusal leaves it in the field for retry.
 */
export function DependenciesSection({ card }: { card: CardDetail }) {
    const [dependsOnId, setDependsOnId] = useState('');
    const setCardDependency = useSetCardDependency(card.id);

    const addDependency = () => {
        const id = dependsOnId.trim();
        if (!id || setCardDependency.isPending) return;
        setCardDependency.mutate({ dependsOnId: id }, { onSuccess: () => setDependsOnId('') });
    };

    return (
        <Stack gap={6}>
            {card.dependsOn.length === 0 ? (
                <Text size="sm" c="dimmed">
                    No dependencies.
                </Text>
            ) : (
                <Stack gap={4}>
                    {card.dependsOn.map(id => (
                        <Group key={id} gap="xs">
                            <Code>{id}</Code>
                            <Button
                                size="xs"
                                variant="subtle"
                                color="red"
                                disabled={setCardDependency.isPending}
                                onClick={() => setCardDependency.mutate({ dependsOnId: id, remove: true })}
                            >
                                Remove
                            </Button>
                        </Group>
                    ))}
                </Stack>
            )}
            <Group gap="xs">
                <TextInput
                    aria-label="Card id to depend on"
                    placeholder="Card id"
                    size="xs"
                    w={140}
                    value={dependsOnId}
                    onChange={event => setDependsOnId(event.currentTarget.value)}
                    disabled={setCardDependency.isPending}
                />
                <Button size="xs" variant="light" disabled={!dependsOnId.trim() || setCardDependency.isPending} onClick={addDependency}>
                    Add dependency
                </Button>
            </Group>
        </Stack>
    );
}
