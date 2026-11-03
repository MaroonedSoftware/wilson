import { useEffect } from 'react';
import { useScrollIntoView } from '@mantine/hooks';
import { Badge, Group, Loader, Paper, ScrollArea, Skeleton, Stack, Text } from '@mantine/core';
import { Markdown } from '#src/components/Markdown.js';
import { formatTimestamp } from '#src/lib/card.js';

/** What a turn needs to be shown, whichever conversation it belongs to. */
export interface ConversationTurn {
    seq: number;
    role: 'user' | 'assistant';
    content: string;
    createdAt: Parameters<typeof formatTimestamp>[0];
}

/** One persisted turn: a role badge and timestamp header over its content, run through the app's
 * one markdown renderer (`Markdown.tsx`) rather than a second one grown for this pane. */
function TurnBubble({ turn }: { turn: ConversationTurn }) {
    return (
        <Paper withBorder p="sm" radius="sm" style={turn.role === 'user' ? { backgroundColor: 'var(--mantine-color-blue-light)' } : undefined}>
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

/** A conversation's turns, kept scrolled to the newest, shared by planning and review. */
export function ConversationView({
    turns,
    outgoingText,
    pendingText,
    emptyText,
}: {
    turns: ConversationTurn[];
    /** What was just sent, while the send is in flight. */
    outgoingText: string | undefined;
    /** The reply so far, while it is being written. */
    pendingText: string;
    emptyText: string;
}) {
    const { scrollableRef, targetRef, scrollIntoView } = useScrollIntoView<HTMLDivElement, HTMLDivElement>();
    const empty = turns.length === 0 && !outgoingText && !pendingText;

    useEffect(() => {
        scrollIntoView({ alignment: 'end' });
    }, [turns, pendingText, outgoingText, scrollIntoView]);

    return (
        <ScrollArea viewportRef={scrollableRef} style={{ flex: 1 }} type="auto">
            <Stack gap="sm" p={4}>
                {empty && (
                    <Text size="sm" c="dimmed">
                        {emptyText}
                    </Text>
                )}
                {turns.map(turn => (
                    <TurnBubble key={turn.seq} turn={turn} />
                ))}
                {outgoingText && <OutgoingTurn text={outgoingText} />}
                {(outgoingText || pendingText) && <InProgressTurn text={pendingText} />}
                <div ref={targetRef} />
            </Stack>
        </ScrollArea>
    );
}
