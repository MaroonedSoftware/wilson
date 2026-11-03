import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Grid, Group, Paper, Stack, Text, Textarea, Title } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import type { CardDiff, ReviewTourAnchor } from '@wilson/sdk';
import { ConversationView } from '#src/components/ConversationPane.js';
import { DiffPane } from '#src/components/DiffPane.js';
import { TourRail } from '#src/components/TourRail.js';
import { reasonFor } from '#src/lib/mutations.js';
import { useReviewState, useReviewTranscript, useSendReviewTurn } from '#src/lib/review.js';

/** Tall enough to read a few turns, and short enough to keep the message box on screen beside the diff. */
const CONVERSATION_HEIGHT = 420;

/** What a tour turn says it asked for, stored and shown like anything else the person sends. */
const WALKTHROUGH_MESSAGE = 'Walk me through this change.';

/**
 * Scrolls to the first diff row an anchor covers. Each file's diff scrolls on its own, and
 * `scrollIntoView` moves every scrolling ancestor, so this reaches a line inside a file and brings that
 * file on screen too.
 */
const scrollToAnchor = (root: HTMLElement | null, anchor: ReviewTourAnchor): void => {
    const number = (row: HTMLElement) => Number(anchor.side === 'old' ? row.dataset.diffOld : row.dataset.diffNew);
    const rows = Array.from(root?.querySelectorAll<HTMLElement>('[data-diff-file]') ?? []);
    rows.find(row => row.dataset.diffFile === anchor.file && number(row) >= anchor.startLine && number(row) <= anchor.endLine)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
    });
};

/**
 * A card's review workspace, for a card in `ready`: the agent's tour and the conversation with it beside
 * the diff, where comments go. Like `DiffPane`, it costs nothing until the tab is opened, because `Tabs`
 * mounts it before then and `diff` stays undefined until the route's query is enabled.
 */
export function ReviewPane({
    diff,
    error,
    project,
    cardId,
}: {
    diff: CardDiff | undefined;
    error: Error | null | undefined;
    project: string | undefined;
    cardId: string;
}) {
    const loaded = diff !== undefined;
    const state = useReviewState(project, cardId, loaded);
    const transcript = useReviewTranscript(project, cardId, loaded);
    const sendTurn = useSendReviewTurn(project, cardId);
    const [text, setText] = useState('');
    const [step, setStep] = useState(0);
    const diffRoot = useRef<HTMLDivElement>(null);

    const review = state.data?.review;
    const tour = review?.tour;
    const head = review && !review.stale ? review.head : undefined;
    const current = tour?.[step];

    // A new tour, or one rewritten shorter, starts over rather than pointing at a step that isn't there.
    const tourLength = tour?.length;
    useEffect(() => {
        setStep(0);
    }, [tourLength, head]);

    const jump = (anchor: ReviewTourAnchor) => scrollToAnchor(diffRoot.current, anchor);

    const goTo = (index: number) => {
        setStep(index);
        const first = tour?.[index]?.anchors.find(anchor => anchor.status === 'in-diff');
        if (first) jump(first);
    };

    const send = () => {
        const message = text.trim();
        if (!message || !head || sendTurn.isPending) return;
        sendTurn.mutate({ head, text: message, stepIndex: tour ? step : undefined }, { onSuccess: () => setText('') });
    };

    const startTour = () => {
        if (head) sendTurn.mutate({ head, text: WALKTHROUGH_MESSAGE, mode: 'tour' });
    };

    return (
        <Grid>
            <Grid.Col span={{ base: 12, md: 5 }}>
                <Stack gap="sm">
                    <TourRail
                        tour={tour}
                        step={step}
                        onStep={goTo}
                        onJump={jump}
                        onStart={startTour}
                        starting={sendTurn.isPending && sendTurn.variables?.mode === 'tour'}
                        disabled={!head || sendTurn.isPending}
                    />
                    <Stack gap={6} h={CONVERSATION_HEIGHT}>
                        <Title order={5}>Conversation</Title>
                        <ConversationView
                            turns={transcript.turns}
                            outgoingText={sendTurn.isPending ? sendTurn.variables?.text : undefined}
                            pendingText={transcript.pendingText}
                            emptyText="Ask anything about this change. The agent reads code at this commit and can't change anything."
                        />
                        <Paper withBorder p="xs" radius="sm">
                            <Stack gap={6}>
                                <Group gap={6} align="flex-end" wrap="nowrap">
                                    <Textarea
                                        aria-label="Message"
                                        placeholder={current ? `Ask about step ${step + 1}…` : 'Ask about this change…'}
                                        autosize
                                        minRows={1}
                                        maxRows={6}
                                        style={{ flex: 1 }}
                                        value={text}
                                        disabled={!head || sendTurn.isPending}
                                        onChange={event => setText(event.currentTarget.value)}
                                        onKeyDown={event => {
                                            if (event.key === 'Enter' && !event.shiftKey) {
                                                event.preventDefault();
                                                send();
                                            }
                                        }}
                                    />
                                    <ActionIcon
                                        size="lg"
                                        aria-label="Send"
                                        disabled={!head || sendTurn.isPending || text.trim().length === 0}
                                        loading={sendTurn.isPending}
                                        onClick={send}
                                    >
                                        <IconSend size={16} />
                                    </ActionIcon>
                                </Group>
                                {sendTurn.error && (
                                    <Text size="xs" c="red">
                                        {reasonFor(sendTurn.error)}
                                    </Text>
                                )}
                            </Stack>
                        </Paper>
                    </Stack>
                </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 7 }}>
                <div ref={diffRoot}>
                    <DiffPane diff={diff} error={error} reviewable highlights={current?.anchors.filter(anchor => anchor.status === 'in-diff')} />
                </div>
            </Grid.Col>
        </Grid>
    );
}
