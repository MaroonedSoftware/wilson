import { useEffect, useState, type ReactNode } from 'react';
import { useScrollIntoView } from '@mantine/hooks';
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Drawer,
    Group,
    Loader,
    Paper,
    ScrollArea,
    Select,
    Skeleton,
    Stack,
    Text,
    Textarea,
    Tooltip,
} from '@mantine/core';
import { IconArchive, IconMessageChatbot, IconPlus, IconSend } from '@tabler/icons-react';
import type { ChatMessage, ChatOperation, ChatPendingAction } from '@wilson/sdk';
import { Markdown } from '#src/components/Markdown.js';
import {
    useArchiveChatThread,
    useChatStream,
    useChatThread,
    useChatThreads,
    useDecideChatAction,
    useSendChatMessage,
    useStartChatThread,
} from '#src/lib/chat.js';
import { reasonFor } from '#src/lib/mutations.js';

/** The reads an answer ran, as small badges under it: what the chat looked at to say what it said. */
function Operations({ operations }: { operations: ChatOperation[] }) {
    if (operations.length === 0) return null;
    return (
        <Group gap={4}>
            {operations.map((operation, index) => (
                <Tooltip key={index} label={JSON.stringify(operation.arguments)}>
                    <Badge size="xs" variant="outline" color={operation.ok ? 'gray' : 'red'}>
                        {operation.name}
                        {operation.project ? ` · ${operation.project}` : ''}
                    </Badge>
                </Tooltip>
            ))}
        </Group>
    );
}

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: ReactNode }) {
    return (
        <Paper withBorder p="sm" radius="sm" style={role === 'user' ? { backgroundColor: 'var(--mantine-color-blue-light)' } : undefined}>
            <Stack gap={6}>{children}</Stack>
        </Paper>
    );
}

function MessageBubble({ message }: { message: ChatMessage }) {
    return (
        <Bubble role={message.role}>
            {message.role === 'user' ? (
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {message.content}
                </Text>
            ) : (
                <Markdown body={message.content} />
            )}
            <Operations operations={message.operations} />
        </Bubble>
    );
}

const STATUS_COLOR: Record<ChatPendingAction['status'], string> = {
    pending: 'yellow',
    running: 'blue',
    done: 'green',
    failed: 'red',
    declined: 'gray',
};

/**
 * A change the chat proposed. Only here does anything change: Confirm runs exactly the operation and
 * arguments shown, as the person's own act; Decline drops it. Past its expiry it can no longer be
 * confirmed, and says so rather than offering a button the server would refuse.
 */
function ActionCard({ action, threadId }: { action: ChatPendingAction; threadId: string }) {
    const decide = useDecideChatAction(threadId);
    const expired = action.status === 'pending' && action.expiresAt.toMillis() <= Date.now();

    return (
        <Paper
            withBorder
            p="sm"
            radius="sm"
            style={{ borderColor: action.status === 'pending' && !expired ? 'var(--mantine-color-yellow-filled)' : undefined }}
        >
            <Stack gap={6}>
                <Group justify="space-between" gap="xs" wrap="nowrap">
                    <Text size="sm" fw={500}>
                        {action.summary}
                    </Text>
                    <Badge size="xs" color={expired ? 'gray' : STATUS_COLOR[action.status]} variant="light">
                        {expired ? 'expired' : action.status}
                    </Badge>
                </Group>
                <Text size="xs" c="dimmed" ff="monospace">
                    {action.operation}
                    {action.project ? ` · ${action.project}` : ''} {JSON.stringify(action.arguments)}
                </Text>
                {action.status === 'pending' && !expired && (
                    <Group gap="xs">
                        <Button size="xs" loading={decide.isPending} onClick={() => decide.mutate({ actionId: action.id, decision: 'confirm' })}>
                            Confirm
                        </Button>
                        <Button
                            size="xs"
                            variant="default"
                            disabled={decide.isPending}
                            onClick={() => decide.mutate({ actionId: action.id, decision: 'decline' })}
                        >
                            Decline
                        </Button>
                    </Group>
                )}
                {action.error && (
                    <Text size="xs" c="red">
                        {action.error}
                    </Text>
                )}
                {decide.isError && (
                    <Text size="xs" c="red">
                        {reasonFor(decide.error)}
                    </Text>
                )}
            </Stack>
        </Paper>
    );
}

type Entry = { kind: 'message'; at: number; message: ChatMessage } | { kind: 'action'; at: number; action: ChatPendingAction };

/** Messages and proposed changes in the order they happened, so a change sits beside the answer that proposed it. */
const timeline = (messages: ChatMessage[], actions: ChatPendingAction[]): Entry[] =>
    [
        ...messages.map((message): Entry => ({ kind: 'message', at: message.createdAt.toMillis(), message })),
        ...actions.map((action): Entry => ({ kind: 'action', at: action.createdAt.toMillis(), action })),
    ].sort((a, b) => a.at - b.at);

/**
 * The chat, modelled on ats's web chat: ask about the board or tell it what to do. It reads freely
 * and proposes changes, which run only when confirmed here (`chat.ck`).
 *
 * Rendered by the root layout on every page, so `project` is whichever project the matched route
 * carries, if any: sent with each message so the agent assumes it unless told otherwise. Threads
 * themselves are not project-scoped, so the panel talks through the unscoped client the root
 * provides, and a thread follows the person from page to page.
 */
export function ChatPanel({ project }: { project?: string }) {
    const [opened, setOpened] = useState(false);
    const [threadId, setThreadId] = useState<string | undefined>(undefined);
    const [draft, setDraft] = useState('');

    const threads = useChatThreads(opened);
    const thread = useChatThread(threadId);
    const live = useChatStream(opened ? threadId : undefined);
    const start = useStartChatThread();
    const send = useSendChatMessage();
    const archive = useArchiveChatThread();
    const { scrollIntoView, targetRef, scrollableRef } = useScrollIntoView<HTMLDivElement, HTMLDivElement>({ duration: 0 });

    const entries = thread.data ? timeline(thread.data.messages, thread.data.actions) : [];
    useEffect(() => scrollIntoView({ alignment: 'end' }), [entries.length, live.text, send.isPending]);

    // A new chat's thread is started before its first message is sent, not by it, so the stream is
    // already listening on the thread when the answer starts arriving.
    const submit = async () => {
        const text = draft.trim();
        if (!text || send.isPending || start.isPending) return;
        let target = threadId;
        if (!target) {
            target = (await start.mutateAsync()).id;
            setThreadId(target);
        }
        send.mutate({ threadId: target, text, project }, { onSuccess: () => setDraft('') });
    };

    return (
        <>
            <Tooltip label="Chat">
                <ActionIcon onClick={() => setOpened(true)} variant="subtle" aria-label="Chat">
                    <IconMessageChatbot size={18} />
                </ActionIcon>
            </Tooltip>
            <Drawer opened={opened} onClose={() => setOpened(false)} position="right" size="lg" title="Chat" padding="md">
                <Stack gap="sm" h="calc(100vh - 100px)">
                    <Group gap="xs" wrap="nowrap">
                        <Select
                            aria-label="Thread"
                            placeholder="New chat"
                            style={{ flex: 1 }}
                            data={(threads.data ?? []).map(listed => ({ value: listed.id, label: listed.title }))}
                            value={threadId ?? null}
                            onChange={value => setThreadId(value ?? undefined)}
                            clearable={false}
                        />
                        <Tooltip label="New chat">
                            <ActionIcon variant="default" size="lg" aria-label="New chat" onClick={() => setThreadId(undefined)}>
                                <IconPlus size={16} />
                            </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Archive this chat">
                            <ActionIcon
                                variant="default"
                                size="lg"
                                aria-label="Archive this chat"
                                disabled={!threadId}
                                onClick={() => threadId && archive.mutate(threadId, { onSuccess: () => setThreadId(undefined) })}
                            >
                                <IconArchive size={16} />
                            </ActionIcon>
                        </Tooltip>
                    </Group>

                    <ScrollArea style={{ flex: 1 }} viewportRef={scrollableRef}>
                        <Stack gap="sm">
                            {!threadId && entries.length === 0 && !send.isPending && (
                                <Text size="sm" c="dimmed">
                                    Ask about the board, or tell it what to do: "what is waiting on me?", "why did 0007 fail testing?", "move 0012
                                    back to planning". It reads on its own; a change waits for you to confirm it.
                                    {project ? ` It assumes the ${project} project unless you name another.` : ''}
                                </Text>
                            )}
                            {thread.isLoading && <Skeleton height={48} />}
                            {entries.map(entry =>
                                entry.kind === 'message' ? (
                                    <MessageBubble key={`m${entry.message.seq}`} message={entry.message} />
                                ) : (
                                    <ActionCard key={`a${entry.action.id}`} action={entry.action} threadId={entry.action.threadId} />
                                ),
                            )}
                            {send.isPending && (
                                <>
                                    <Bubble role="user">
                                        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                            {send.variables.text}
                                        </Text>
                                    </Bubble>
                                    <Bubble role="assistant">
                                        {live.text ? <Markdown body={live.text} /> : <Loader size="xs" />}
                                        <Operations operations={live.operations} />
                                    </Bubble>
                                </>
                            )}
                            <div ref={targetRef} />
                        </Stack>
                    </ScrollArea>

                    {(send.isError || start.isError) && (
                        <Alert color="red" p="xs">
                            {reasonFor(send.error ?? start.error)}
                        </Alert>
                    )}
                    <Group gap="xs" align="flex-end" wrap="nowrap">
                        <Textarea
                            aria-label="Message"
                            placeholder="Message the chat"
                            style={{ flex: 1 }}
                            autosize
                            minRows={1}
                            maxRows={6}
                            value={draft}
                            onChange={event => setDraft(event.currentTarget.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault();
                                    void submit();
                                }
                            }}
                        />
                        <ActionIcon
                            size="lg"
                            aria-label="Send"
                            onClick={() => void submit()}
                            loading={send.isPending || start.isPending}
                            disabled={!draft.trim()}
                        >
                            <IconSend size={16} />
                        </ActionIcon>
                    </Group>
                </Stack>
            </Drawer>
        </>
    );
}
