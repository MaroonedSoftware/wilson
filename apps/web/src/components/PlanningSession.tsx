import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useScrollIntoView } from '@mantine/hooks';
import { ActionIcon, Alert, Badge, Group, Loader, Paper, ScrollArea, Skeleton, Stack, Text, Textarea } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import type { CardDetail, PlanTurn } from '@wilson/sdk';
import { Markdown } from '#src/components/Markdown.js';
import { formatTimestamp } from '#src/lib/card.js';
import { reasonFor, useSendPlanTurn } from '#src/lib/mutations.js';
import { usePlanTranscript } from '#src/lib/plan.js';
import { wilson } from '#src/lib/sdk.js';

/**
 * `Composer`'s `autosize` `Textarea` (below) subscribes to the CSS Font Loading API
 * unconditionally, on every mount, to re-measure once web fonts finish loading — every real
 * browser has `document.fonts`, but jsdom (this app's test environment) does not, and reading
 * `.addEventListener` off `undefined` would otherwise crash this pane before it ever rendered.
 * Guarded on the property actually being absent, so a real browser's implementation is never
 * touched.
 */
if (typeof document !== 'undefined' && !document.fonts) {
    Object.defineProperty(document, 'fonts', {
        value: { addEventListener: () => {}, removeEventListener: () => {} },
        configurable: true,
    });
}

/** One persisted turn: a role badge and timestamp header over its content, run through the app's
 * one markdown renderer (`Markdown.tsx`) rather than a second one grown for this pane. */
function TurnBubble({ turn }: { turn: PlanTurn }) {
    return (
        <Paper
            withBorder
            p="sm"
            radius="sm"
            style={turn.role === 'user' ? { backgroundColor: 'var(--mantine-color-blue-light)' } : undefined}
        >
            <Stack gap={4}>
                <Group gap={6} justify="space-between">
                    <Badge size="xs" color={turn.role === 'user' ? 'blue' : 'gray'} variant="light">
                        {turn.role}
                    </Badge>
                    <Text size="xs" c="dimmed">
                        {formatTimestamp(turn.createdAt)}
                    </Text>
                </Group>
                <Markdown body={turn.content} />
            </Stack>
        </Paper>
    );
}

/**
 * The assistant's reply while it is still being written — `text` is whatever `delta` chunks have
 * landed so far, shown rather than left absent, with a `Loader` standing in for "more is coming."
 * A `Skeleton` fills the gap before the first chunk arrives, so a turn just sent doesn't read as
 * nothing having happened.
 */
function InProgressTurn({ text }: { text: string }) {
    return (
        <Paper withBorder p="sm" radius="sm">
            <Stack gap={4}>
                <Group gap={6} justify="space-between">
                    <Badge size="xs" color="gray" variant="light">
                        assistant
                    </Badge>
                    <Loader size={12} />
                </Group>
                {text ? <Markdown body={text} /> : <Skeleton height={12} width="60%" />}
            </Stack>
        </Paper>
    );
}

/**
 * The user's own turn, echoed the moment it is sent — the exact text just submitted (a mutation's
 * own `variables`, not state this pane accumulated), so showing it needs no round trip. Carries no
 * timestamp: the real, persisted row only exists once a reconnect replays it, and this stands in
 * for that without claiming it already happened.
 */
function OutgoingTurn({ text }: { text: string }) {
    return (
        <Paper withBorder p="sm" radius="sm" style={{ backgroundColor: 'var(--mantine-color-blue-light)' }}>
            <Stack gap={4}>
                <Badge size="xs" color="blue" variant="light">
                    user
                </Badge>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {text}
                </Text>
            </Stack>
        </Paper>
    );
}

/**
 * The textarea and send control. Disabled while a turn is already in flight or the session has not
 * finished opening. A refusal shows the server's own sentence beneath the control (`reasonFor`,
 * `mutations.ts`) rather than a generic message, and leaves the typed text in place so it can be
 * edited and resent instead of retyped.
 */
function Composer({
    sendTurn,
    disabled,
    onSent,
}: {
    sendTurn: ReturnType<typeof useSendPlanTurn>;
    disabled: boolean;
    onSent: (turn: PlanTurn) => void;
}) {
    const [text, setText] = useState('');

    const send = () => {
        const trimmed = text.trim();
        if (!trimmed || sendTurn.isPending) return;
        sendTurn.mutate(trimmed, { onSuccess: onSent });
        setText('');
    };

    return (
        <Paper withBorder p="xs" radius="sm">
            <Stack gap={6}>
                <Group gap={6} align="flex-end" wrap="nowrap">
                    <Textarea
                        aria-label="Message"
                        placeholder="Talk through the plan…"
                        autosize
                        minRows={1}
                        maxRows={8}
                        style={{ flex: 1 }}
                        value={text}
                        disabled={disabled || sendTurn.isPending}
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
                        variant="filled"
                        aria-label="Send"
                        disabled={disabled || sendTurn.isPending || text.trim().length === 0}
                        loading={sendTurn.isPending}
                        onClick={send}
                    >
                        <IconSend size={16} />
                    </ActionIcon>
                </Group>
                {sendTurn.isError && (
                    <Text size="xs" c="red">
                        {reasonFor(sendTurn.error)}
                    </Text>
                )}
            </Stack>
        </Paper>
    );
}

/**
 * The conversation half of card 0121's two-pane `planning` view — the draft pane beside it is
 * [[0138]]. Opens (or rejoins — deterministic per card, card 0058) the session on mount, streams
 * the transcript through `usePlanTranscript` (`lib/plan.ts`), and renders the composer beneath it.
 *
 * `openAPlanningSession` is called here rather than left to the first turn's own lazy cut
 * (`PlanService.appendTurn`'s `isFirstTurn` branch) so the two guards it shares with `turn` — a
 * card outside `planning`, or one whose real branch already has work — surface as soon as the pane
 * mounts, as an inline `Alert`, instead of only once an operator has typed a first message. The
 * composer stays disabled until it succeeds.
 *
 * The transcript itself is never rebuilt by hand from what this component has seen: `turns` and
 * `pendingText` come straight from `usePlanTranscript`, and the one thing added here —
 * `sendTurn.variables` while a send is in flight — is the literal text just submitted, not a guess
 * folded in from the stream.
 */
export function PlanningSessionPane({ card }: { card: CardDetail }) {
    const session = useQuery({ queryKey: ['plan-session', card.id], queryFn: () => wilson.board.openAPlanningSession(card.id) });
    const transcript = usePlanTranscript(card.id, true);
    const sendTurn = useSendPlanTurn(card.id);
    const { scrollableRef, targetRef, scrollIntoView } = useScrollIntoView<HTMLDivElement, HTMLDivElement>();

    const outgoingText = sendTurn.isPending ? sendTurn.variables : undefined;
    const empty = transcript.turns.length === 0 && !outgoingText && !transcript.pendingText;

    useEffect(() => {
        scrollIntoView({ alignment: 'end' });
    }, [transcript.turns, transcript.pendingText, outgoingText, scrollIntoView]);

    return (
        <Stack gap="xs" h="100%">
            {transcript.error && (
                <Alert color="red" title="Stream disconnected">
                    {transcript.error}
                </Alert>
            )}
            {session.error && (
                <Alert color="red" title="Could not open the planning session">
                    {reasonFor(session.error)}
                </Alert>
            )}
            <ScrollArea viewportRef={scrollableRef} style={{ flex: 1 }} type="auto">
                <Stack gap="sm" p={4}>
                    {empty && (
                        <Text size="sm" c="dimmed">
                            No turns yet — start the conversation below.
                        </Text>
                    )}
                    {transcript.turns.map(turn => (
                        <TurnBubble key={turn.seq} turn={turn} />
                    ))}
                    {outgoingText && <OutgoingTurn text={outgoingText} />}
                    {(outgoingText || transcript.pendingText) && <InProgressTurn text={transcript.pendingText} />}
                    <div ref={targetRef} />
                </Stack>
            </ScrollArea>
            <Composer sendTurn={sendTurn} disabled={!session.data} onSent={transcript.commitTurn} />
        </Stack>
    );
}
