import { useEffect, useState } from 'react';
import { useDisclosure } from '@mantine/hooks';
import { Alert, Badge, Box, Button, Group, Loader, Modal, ScrollArea, SegmentedControl, Stack, Text, Textarea, Typography } from '@mantine/core';
import type { CardDetail } from '@wilson/sdk';
import { CommentableDraft } from '#src/components/CommentableDraft.js';
import { type DiffLine, diffLines } from '#src/lib/diff.js';
import { reasonFor, useSaveAPlanDraft } from '#src/lib/mutations.js';
import { usePlanDraft } from '#src/lib/plan.js';

/** One line of `diffLines`' output — plain text, coloured by whether it was added or removed, in
 * a monospace `Code`-like block. No context lines, matching the terminal's own diff. */
function DiffView({ lines }: { lines: DiffLine[] }) {
    if (lines.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No changes.
            </Text>
        );
    }
    return (
        <ScrollArea.Autosize mah={360} type="auto">
            <Stack gap={2} p={4} style={{ fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 'var(--mantine-font-size-xs)' }}>
                {lines.map((line, index) => (
                    <Text key={index} span c={line.kind === 'add' ? 'teal' : 'red'} style={{ whiteSpace: 'pre-wrap' }}>
                        {line.kind === 'add' ? '+ ' : '- '}
                        {line.text}
                    </Text>
                ))}
            </Stack>
        </ScrollArea.Autosize>
    );
}

/**
 * The confirmation gate task 2 asks for: a diff of `draft` against `card.body`, a Mantine `Modal`
 * (never a bare `window.confirm`, this card's Constraints), and the explicit write only the
 * confirm button triggers. `PlanService.save` is the only validator — this dialog shows a refusal
 * verbatim (`reasonFor`) and leaves `draft` exactly as it was, the same "on explicit confirmation,
 * writes nothing until confirmed, never re-validates client-side" contract `plan.command.ts`'s own
 * terminal flow already lives under.
 */
function ApproveDialog({
    cardId,
    opened,
    onClose,
    draft,
    currentBody,
    saveDraft,
    onSaved,
}: {
    cardId: string;
    opened: boolean;
    onClose: () => void;
    draft: string;
    currentBody: string;
    saveDraft: ReturnType<typeof useSaveAPlanDraft>;
    onSaved: () => void;
}) {
    const changes = diffLines(currentBody, draft);

    return (
        <Modal opened={opened} onClose={onClose} title={`Write this as a new version of ${cardId}?`} size="lg">
            <Stack gap="sm">
                <DiffView lines={changes} />
                {saveDraft.isError && (
                    <Text size="sm" c="red">
                        {reasonFor(saveDraft.error)}
                    </Text>
                )}
                <Group justify="flex-end">
                    <Button variant="default" onClick={onClose} disabled={saveDraft.isPending}>
                        Cancel
                    </Button>
                    <Button loading={saveDraft.isPending} onClick={() => saveDraft.mutate(draft, { onSuccess: onSaved })}>
                        Write this version
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}

/**
 * Card [[0138]]'s half of card 0137's two-pane `planning` view: the draft beside the conversation
 * (`PlanningSessionPane`), replacing that card's read-only placeholder. Fetches through
 * `usePlanDraft` (`lib/plan.ts`), lets a person edit the text directly (a `Textarea`, this card's
 * Constraints — not a hand-rolled contenteditable), and gates any write behind `ApproveDialog`'s
 * diff and confirmation.
 *
 * **Whose edit wins.** The agent writes `draft.md` through its own session while a person may be
 * editing the same text on screen; this card adds no lock (see Constraints — that is a decision
 * left to a later card), so the two can collide. The rule here: a person's in-progress edit is
 * never silently overwritten by a poll that lands mid-edit. `baseline` is the draft text last
 * accepted — from the server, or from an explicit choice below — and `text` is diverged from it
 * ("dirty") the moment a keystroke changes it. While dirty, an incoming poll that disagrees with
 * `baseline` is not applied automatically; instead the banner below says so and offers to load it,
 * so the collision is visible rather than invisible. The person's edit wins by default because
 * they are the one looking at the screen right now — a silent overwrite of live-in-progress typing
 * would be a worse surprise than a stale poll for the few seconds until they notice the banner.
 * Once `text` is not dirty (unedited, or the incoming version was explicitly loaded, or a save just
 * landed), the next poll is free to sync it forward with no banner at all.
 */
export function DraftPane({ card }: { card: CardDetail }) {
    const draftQuery = usePlanDraft(card.id, true);
    const saveDraft = useSaveAPlanDraft(card.id);
    const [mode, setMode] = useState<'edit' | 'preview'>('edit');
    const [diffOpened, diffHandlers] = useDisclosure(false);

    const [text, setText] = useState('');
    const [baseline, setBaseline] = useState<string>();
    const dirty = baseline !== undefined && text !== baseline;

    // Syncs `text` from the server whenever it isn't dirty — the ordinary path, taken on first
    // load and after every poll that finds nothing to protect. Skipped while dirty (read through
    // `dirty` inside the effect rather than listed as a dependency: re-running this on every dirty
    // flip would fight the explicit "load the agent's version" button below, which sets `text` and
    // clears `dirty` together in one click); see the component doc above for what happens instead.
    useEffect(() => {
        const body = draftQuery.data?.body;
        if (body === undefined || dirty) return;
        setText(body);
        setBaseline(body);
    }, [draftQuery.data]);

    const incoming = draftQuery.data?.body;
    const collision = dirty && incoming !== undefined && incoming !== baseline;

    const loadIncoming = () => {
        if (incoming === undefined) return;
        setText(incoming);
        setBaseline(incoming);
    };

    const loaded = draftQuery.data !== undefined;
    const approveDisabled = !loaded || saveDraft.isPending || text.trim().length === 0 || text === card.body;

    return (
        <Stack gap="xs" h="100%">
            {draftQuery.error && (
                <Alert color="red" title="Could not load the draft">
                    {reasonFor(draftQuery.error)}
                </Alert>
            )}
            {collision && (
                <Alert color="yellow" title="The agent wrote a new draft while you were editing">
                    <Stack gap={6}>
                        <Text size="sm">Your edit is kept below — nothing has been lost.</Text>
                        <Button size="xs" variant="light" onClick={loadIncoming}>
                            Use the agent's version instead
                        </Button>
                    </Stack>
                </Alert>
            )}

            <Group justify="space-between" wrap="nowrap">
                <SegmentedControl
                    size="xs"
                    value={mode}
                    onChange={value => setMode(value as 'edit' | 'preview')}
                    data={[
                        { label: 'Edit', value: 'edit' },
                        { label: 'Preview', value: 'preview' },
                    ]}
                />
                <Group gap={6} wrap="nowrap">
                    {dirty && !collision && (
                        <Badge size="xs" color="gray" variant="light">
                            unsaved
                        </Badge>
                    )}
                    <Button size="xs" disabled={approveDisabled} onClick={diffHandlers.open}>
                        Approve…
                    </Button>
                </Group>
            </Group>

            {!loaded ? (
                <Group justify="center" style={{ flex: 1 }}>
                    <Loader size="sm" />
                </Group>
            ) : (
                <ScrollArea style={{ flex: 1 }} type="auto">
                    {mode === 'edit' ? (
                        <Textarea
                            aria-label="Draft"
                            value={text}
                            onChange={event => setText(event.currentTarget.value)}
                            autosize
                            minRows={20}
                            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                        />
                    ) : (
                        <Box p={4}>
                            <Typography>
                                <CommentableDraft cardId={card.id} text={text} />
                            </Typography>
                        </Box>
                    )}
                </ScrollArea>
            )}

            <ApproveDialog
                cardId={card.id}
                opened={diffOpened}
                onClose={diffHandlers.close}
                draft={text}
                currentBody={card.body}
                saveDraft={saveDraft}
                onSaved={() => {
                    diffHandlers.close();
                    // The just-written body is the new baseline: the card's own `body` prop updates
                    // on the next render from `useSaveAPlanDraft`'s cache write, and treating what we
                    // just sent as accepted keeps the very next poll from reading as a collision
                    // against our own save.
                    setBaseline(text);
                }}
            />
        </Stack>
    );
}
