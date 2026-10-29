import { useEffect, useState, type ReactNode } from 'react';
import { useScrollIntoView } from '@mantine/hooks';
import {
    ActionIcon,
    Alert,
    Badge,
    Box,
    Button,
    Center,
    Chip,
    Group,
    Loader,
    NavLink,
    Paper,
    ScrollArea,
    Select,
    Skeleton,
    Stack,
    Text,
    Textarea,
    Title,
    Tooltip,
} from '@mantine/core';
import { IconArchive, IconPlus, IconSend } from '@tabler/icons-react';
import type { ChatMessage, ChatOperation, ChatPendingAction, ChatThread } from '@wilson/sdk';
import { Markdown } from '#src/components/Markdown.js';
import {
    setActiveThread,
    useActiveThread,
    useArchiveChatThread,
    useChatStream,
    useChatThread,
    useChatThreads,
    useDecideChatAction,
    useSendChatMessage,
    useStartChatThread,
} from '#src/lib/chat.js';
import { reasonFor } from '#src/lib/mutations.js';

/** How wide the conversation runs on the full page, so a line of an answer stays readable. */
const COLUMN_WIDTH = 760;

/** What a new chat offers to ask, one click each. */
export const SUGGESTIONS = [
    'What is waiting on me?',
    'What is in review right now?',
    'Why did the last card fail testing?',
    'What did the board spend today?',
];

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
function ActionCard({ action }: { action: ChatPendingAction }) {
    const decide = useDecideChatAction(action.threadId);
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

function Composer({ onSend, busy, autoFocus }: { onSend: (text: string) => Promise<boolean>; busy: boolean; autoFocus?: boolean }) {
    const [draft, setDraft] = useState('');
    const submit = async () => {
        const text = draft.trim();
        if (!text || busy) return;
        if (await onSend(text)) setDraft('');
    };

    return (
        <Group gap="xs" align="flex-end" wrap="nowrap">
            <Textarea
                aria-label="Message"
                placeholder="Ask about the board, or tell it what to do"
                style={{ flex: 1 }}
                autosize
                minRows={1}
                maxRows={6}
                autoFocus={autoFocus}
                value={draft}
                onChange={event => setDraft(event.currentTarget.value)}
                onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void submit();
                    }
                }}
            />
            <ActionIcon size="lg" aria-label="Send" onClick={() => void submit()} loading={busy} disabled={!draft.trim()}>
                <IconSend size={16} />
            </ActionIcon>
        </Group>
    );
}

/** The person's threads, down the side of the full-page chat. */
function ThreadList({ threads, activeThreadId }: { threads: ChatThread[]; activeThreadId?: string }) {
    const archive = useArchiveChatThread();
    return (
        <Stack gap="xs" h="100%">
            <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => setActiveThread(undefined)}>
                New chat
            </Button>
            <ScrollArea style={{ flex: 1 }}>
                <Stack gap={2}>
                    {threads.map(thread => (
                        <NavLink
                            key={thread.id}
                            label={thread.title}
                            active={thread.id === activeThreadId}
                            onClick={() => setActiveThread(thread.id)}
                            rightSection={
                                thread.id === activeThreadId ? (
                                    <ActionIcon
                                        component="span"
                                        size="sm"
                                        variant="subtle"
                                        aria-label="Archive this chat"
                                        onClick={event => {
                                            event.stopPropagation();
                                            archive.mutate(thread.id, { onSuccess: () => setActiveThread(undefined) });
                                        }}
                                    >
                                        <IconArchive size={14} />
                                    </ActionIcon>
                                ) : undefined
                            }
                        />
                    ))}
                </Stack>
            </ScrollArea>
        </Stack>
    );
}

export interface ChatViewProps {
    /** `page` fills the home route, threads down the side; `panel` fits the dock, threads in a picker. */
    variant: 'page' | 'panel';
    /** The project of the page the person is on, sent with each message so the agent assumes it. */
    project?: string;
    /** Extra controls for the panel's header, such as the dock's own. */
    actions?: ReactNode;
}

/**
 * The chat, modelled on ats's web chat: ask about the board or tell it what to do. It reads freely
 * and proposes changes, which run only when confirmed here (`chat.ck`).
 *
 * The same conversation in both places it shows — the home page and the dock beside every other
 * page — because both read the one active thread (`setActiveThread`). Threads are not
 * project-scoped, so this talks through the unscoped client the root provides.
 */
export function ChatView({ variant, project, actions }: ChatViewProps) {
    const threadId = useActiveThread();
    const threads = useChatThreads(true);
    const thread = useChatThread(threadId);
    const live = useChatStream(threadId);
    const start = useStartChatThread();
    const send = useSendChatMessage();
    const archive = useArchiveChatThread();
    const { scrollIntoView, targetRef, scrollableRef } = useScrollIntoView<HTMLDivElement, HTMLDivElement>({ duration: 0 });

    const entries = thread.data ? timeline(thread.data.messages, thread.data.actions) : [];
    useEffect(() => scrollIntoView({ alignment: 'end' }), [entries.length, live.text, send.isPending]);

    // A thread that no longer exists (archived elsewhere, or a stale id from another database) is let
    // go of, so the view opens on a new chat rather than an error.
    const missing = thread.isError && (thread.error as { status?: number }).status === 404;
    useEffect(() => {
        if (missing) setActiveThread(undefined);
    }, [missing]);

    // A new chat's thread is started before its first message is sent, not by it, so the stream is
    // already listening on the thread when the answer starts arriving. Answers whether it was sent,
    // so the composer keeps what was typed when it was not.
    const sendText = async (text: string): Promise<boolean> => {
        try {
            let target = threadId;
            if (!target) {
                target = (await start.mutateAsync()).id;
                setActiveThread(target);
            }
            await send.mutateAsync({ threadId: target, text, ...(project ? { project } : {}) });
            return true;
        } catch {
            return false;
        }
    };

    const busy = start.isPending || send.isPending;
    const failure = send.error ?? start.error;
    const empty = !threadId && !busy;

    const conversation = empty ? (
        <Center h="100%" px="md">
            <Stack gap="lg" w="100%" maw={COLUMN_WIDTH}>
                <Stack gap={4} ta="center">
                    <Title order={variant === 'page' ? 2 : 4}>What should we do?</Title>
                    <Text c="dimmed" size="sm">
                        Ask about the board, or tell it what to do. It reads on its own; a change waits for you to confirm it.
                        {project ? ` It assumes the ${project} project unless you name another.` : ''}
                    </Text>
                </Stack>
                <Composer onSend={sendText} busy={busy} autoFocus={variant === 'page'} />
                <Group gap="xs" justify="center">
                    {SUGGESTIONS.map(suggestion => (
                        <Chip key={suggestion} checked={false} variant="outline" size="sm" onClick={() => void sendText(suggestion)} disabled={busy}>
                            {suggestion}
                        </Chip>
                    ))}
                </Group>
                {failure && (
                    <Alert color="red" p="xs">
                        {reasonFor(failure)}
                    </Alert>
                )}
            </Stack>
        </Center>
    ) : (
        <Stack gap={0} h="100%">
            <ScrollArea style={{ flex: 1 }} viewportRef={scrollableRef}>
                <Stack gap="sm" px="md" py="md" mx="auto" maw={COLUMN_WIDTH}>
                    {thread.isLoading && <Skeleton height={48} />}
                    {entries.map(entry =>
                        entry.kind === 'message' ? (
                            <MessageBubble key={`m${entry.message.seq}`} message={entry.message} />
                        ) : (
                            <ActionCard key={`a${entry.action.id}`} action={entry.action} />
                        ),
                    )}
                    {send.isPending && (
                        <Bubble role="user">
                            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                {send.variables.text}
                            </Text>
                        </Bubble>
                    )}
                    {/* The answer in progress: to a message just sent, or the follow-up to a confirmed change. */}
                    {(send.isPending || live.text || live.operations.length > 0) && (
                        <Bubble role="assistant">
                            {live.text ? <Markdown body={live.text} /> : <Loader size="xs" />}
                            <Operations operations={live.operations} />
                        </Bubble>
                    )}
                    <div ref={targetRef} />
                </Stack>
            </ScrollArea>
            <Stack gap="xs" px="md" pb="md" pt="xs" mx="auto" w="100%" maw={COLUMN_WIDTH}>
                {failure && (
                    <Alert color="red" p="xs">
                        {reasonFor(failure)}
                    </Alert>
                )}
                <Composer onSend={sendText} busy={busy} />
            </Stack>
        </Stack>
    );

    const threadList = threads.data ?? [];

    if (variant === 'panel') {
        return (
            <Stack gap={0} h="100%">
                <Group gap="xs" px="md" py="xs" wrap="nowrap" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
                    <Select
                        aria-label="Thread"
                        placeholder="New chat"
                        size="xs"
                        style={{ flex: 1 }}
                        data={threadList.map(listed => ({ value: listed.id, label: listed.title }))}
                        value={threadId ?? null}
                        onChange={value => setActiveThread(value ?? undefined)}
                        allowDeselect={false}
                    />
                    <Tooltip label="New chat">
                        <ActionIcon variant="subtle" aria-label="New chat" onClick={() => setActiveThread(undefined)}>
                            <IconPlus size={16} />
                        </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Archive this chat">
                        <ActionIcon
                            variant="subtle"
                            aria-label="Archive this chat"
                            disabled={!threadId}
                            onClick={() => threadId && archive.mutate(threadId, { onSuccess: () => setActiveThread(undefined) })}
                        >
                            <IconArchive size={16} />
                        </ActionIcon>
                    </Tooltip>
                    {actions}
                </Group>
                <Box style={{ flex: 1, minHeight: 0 }}>{conversation}</Box>
            </Stack>
        );
    }

    return (
        <Group gap={0} h="100%" wrap="nowrap" align="stretch">
            <Box visibleFrom="sm" w={260} p="sm" style={{ borderRight: '1px solid var(--mantine-color-default-border)', flexShrink: 0 }}>
                <ThreadList threads={threadList} activeThreadId={threadId} />
            </Box>
            <Box style={{ flex: 1, minWidth: 0 }}>{conversation}</Box>
        </Group>
    );
}
