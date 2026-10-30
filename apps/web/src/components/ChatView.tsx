import { useEffect, useState, type ReactNode } from 'react';
import { useScrollIntoView } from '@mantine/hooks';
import { ActionIcon, Alert, Box, Center, Chip, Group, ScrollArea, Skeleton, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { ChatMessage, ChatPendingAction } from '@wilson/sdk';
import { ChatComposer } from '#src/components/ChatComposer.js';
import { ChatActionCard, isAwaiting } from '#src/components/ChatActionCard.js';
import { AnswerInProgress, Message, UserMessage } from '#src/components/ChatMessages.js';
import { ThreadList, ThreadMenu } from '#src/components/ChatThreads.js';
import {
    setActiveThread,
    useActiveThread,
    useChatStream,
    useChatThread,
    useChatThreads,
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

type Entry = { kind: 'message'; at: number; message: ChatMessage } | { kind: 'action'; at: number; action: ChatPendingAction };

/** Messages and proposed changes in the order they happened, so a change sits beside the answer that proposed it. */
const timeline = (messages: ChatMessage[], actions: ChatPendingAction[]): Entry[] =>
    [
        ...messages.map((message): Entry => ({ kind: 'message', at: message.createdAt.toMillis(), message })),
        ...actions.map((action): Entry => ({ kind: 'action', at: action.createdAt.toMillis(), action })),
    ].sort((a, b) => a.at - b.at);

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
    const [typed, setTyped] = useState('');
    const { scrollIntoView, targetRef, scrollableRef } = useScrollIntoView<HTMLDivElement, HTMLDivElement>({ duration: 0 });

    const entries = thread.data ? timeline(thread.data.messages, thread.data.actions) : [];
    const awaiting = thread.data?.actions.some(isAwaiting) ?? false;
    const busy = start.isPending || send.isPending;
    const answering = busy || live.text !== '' || live.operations.length > 0;
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

    // The box clears as soon as a message goes, as a chat's does, and gets it back if it did not go,
    // unless something new has been typed since.
    const sendDraft = (text: string) => {
        setTyped('');
        void sendText(text).then(sent => {
            if (!sent) setTyped(current => current || text);
        });
    };

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
                <ChatComposer
                    value={typed}
                    onChange={setTyped}
                    onSend={sendDraft}
                    disabled={busy}
                    autoFocus={variant === 'page'}
                    suggestion={SUGGESTIONS[0]}
                />
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
            <ScrollArea style={{ flex: 1 }} viewportRef={scrollableRef} type="auto">
                <Stack gap="md" px="md" py="lg" mx="auto" maw={COLUMN_WIDTH} aria-live="polite">
                    {thread.isLoading && <Skeleton height={48} />}
                    {entries.map(entry =>
                        entry.kind === 'message' ? (
                            <Message key={`m${entry.message.seq}`} message={entry.message} />
                        ) : (
                            <ChatActionCard key={`a${entry.action.id}`} action={entry.action} />
                        ),
                    )}
                    {send.isPending && <UserMessage text={send.variables.text} />}
                    {/* The answer in progress: to a message just sent, or the follow-up to a confirmed change. */}
                    {answering && <AnswerInProgress text={live.text} operations={live.operations} />}
                    <div ref={targetRef} />
                </Stack>
            </ScrollArea>
            <Stack gap="xs" px="md" pb="md" pt="xs" mx="auto" w="100%" maw={COLUMN_WIDTH}>
                {failure && (
                    <Alert color="red" p="xs">
                        {reasonFor(failure)}
                    </Alert>
                )}
                <ChatComposer
                    value={typed}
                    onChange={setTyped}
                    onSend={sendDraft}
                    disabled={busy}
                    autoFocus={variant === 'page'}
                    {...(awaiting ? { placeholder: 'Confirm or decline above, or ask for something else…' } : {})}
                />
            </Stack>
        </Stack>
    );

    const threadList = threads.data ?? [];

    const header = (
        <Group justify="space-between" px="md" py="xs" wrap="nowrap" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
            <ThreadMenu threads={threadList} activeThreadId={threadId} />
            <Group gap={2} wrap="nowrap">
                <Tooltip label="New chat">
                    <ActionIcon variant="subtle" aria-label="New chat" onClick={() => setActiveThread(undefined)}>
                        <IconPlus size={18} />
                    </ActionIcon>
                </Tooltip>
                {actions}
            </Group>
        </Group>
    );

    if (variant === 'panel') {
        return (
            <Stack gap={0} h="100%">
                {header}
                <Box style={{ flex: 1, minHeight: 0 }}>{conversation}</Box>
            </Stack>
        );
    }

    return (
        <Group gap={0} h="100%" wrap="nowrap" align="stretch">
            <Box visibleFrom="md" w={260} p="sm" style={{ borderRight: '1px solid var(--mantine-color-default-border)', flexShrink: 0 }}>
                <ThreadList threads={threadList} activeThreadId={threadId} />
            </Box>
            <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                <Box hiddenFrom="md">{header}</Box>
                <Box style={{ flex: 1, minHeight: 0 }}>{conversation}</Box>
            </Stack>
        </Group>
    );
}
