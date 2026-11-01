import { useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useDisclosure } from '@mantine/hooks';
import { Button, Group, Modal, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { CARD_BODY_SKELETON } from '#src/lib/card.js';
import { useCreateCard } from '#src/lib/mutations.js';

/**
 * Card 0142: the board's one control for filing a card, so capturing a thought no longer requires
 * `$EDITOR` and a shell (`wilson card create`, `packages/cli/src/commands/card/create.command.ts`).
 *
 * A `Modal` rather than a route (this card's Constraints list either as acceptable) — it opens from
 * wherever the board's toolbar renders it and closes back to the same view, with no page to leave
 * and return to for what is a two-field form.
 *
 * Always files into `parking-lot`, the same default the CLI uses and the convention the rest of
 * the board follows: a thought captured now, promoted into `planning` by a human later. There is no
 * stage picker here — offering one risks landing a card past the plan contract (`implementing`
 * skips it entirely), which is exactly what this control must never make easy.
 *
 * The body starts from `CARD_BODY_SKELETON`, the same six empty headings `create.command.ts` seeds
 * `$EDITOR` with, so a card filed as a plan starts in the right shape. Nothing here requires those
 * headings stay — a parking-lot capture is prose under `## Note` on this board, and clearing the
 * skeleton for that is exactly as easy as it is from the CLI.
 *
 * `useCreateCard` (`lib/mutations.ts`) surfaces a refusal as a notification and leaves this modal's
 * `title`/`body` state untouched, so a rejected attempt is still on screen to fix and resend. Only a
 * successful create clears the form, closes the modal, and navigates to the new card's own page —
 * the thing just filed, on screen, per this card's Tasks.
 *
 * Card 0159: that navigation is the whole of "file and talk" — no separate call, no session that
 * exists before the card does. Landing on the new card's own page for a fresh `parking-lot` card is
 * enough on its own, because `CardDetailView` now gives that stage the same two-pane session
 * `planning` gets, and `PlanningSessionPane` opens it the moment it mounts. The card just filed is on
 * screen, already mid-conversation.
 *
 * Card 0155: that page is `/projects/$project/cards/$cardId`, so the navigation needs a `project` —
 * read from the router the same way `Markdown.tsx` does. This control only ever renders on the
 * board's project-scoped route (`projects.$project.index.tsx`); the top-level `/` it used to sit on,
 * and the `/cards/$cardId` card 0159's paragraph above originally named, are both gone.
 */
export function NewCardControl() {
    const navigate = useNavigate();
    const { project } = useParams({ strict: false });
    const [opened, handlers] = useDisclosure(false);
    const [title, setTitle] = useState('');
    const [body, setBody] = useState(CARD_BODY_SKELETON);
    const createCard = useCreateCard();

    const openFresh = () => {
        setTitle('');
        setBody(CARD_BODY_SKELETON);
        handlers.open();
    };

    const canSubmit = title.trim().length > 0 && body.trim().length > 0 && !createCard.isPending;

    const submit = () => {
        if (!canSubmit) return;
        createCard.mutate(
            { title: title.trim(), stage: 'parking-lot', body },
            {
                onSuccess: card => {
                    handlers.close();
                    setTitle('');
                    setBody(CARD_BODY_SKELETON);
                    if (project) void navigate({ to: '/projects/$project/cards/$cardId', params: { project, cardId: card.id } });
                },
            },
        );
    };

    return (
        <>
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={openFresh}>
                New card
            </Button>
            <Modal opened={opened} onClose={handlers.close} title="File a new card" size="lg">
                <Stack gap="sm">
                    <Text size="sm" c="dimmed">
                        Lands in parking-lot, same as <code>wilson card create</code> — you can talk it through right away, and promote it into
                        planning when it's ready.
                    </Text>
                    <TextInput
                        label="Title"
                        value={title}
                        onChange={event => setTitle(event.currentTarget.value)}
                        disabled={createCard.isPending}
                        data-autofocus
                    />
                    <Textarea
                        label="Body"
                        description="Starts from the plan skeleton — clear it for a quick note instead."
                        value={body}
                        onChange={event => setBody(event.currentTarget.value)}
                        autosize
                        minRows={12}
                        disabled={createCard.isPending}
                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                    />
                    <Group justify="flex-end">
                        <Button variant="default" onClick={handlers.close} disabled={createCard.isPending}>
                            Cancel
                        </Button>
                        <Button loading={createCard.isPending} disabled={!canSubmit} onClick={submit}>
                            Create
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}
