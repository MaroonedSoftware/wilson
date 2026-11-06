import { Fragment } from 'react';
import { Box, Group, Loader, Paper, Text, Tooltip } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import type { ChatAttachment, ChatMessage, ChatOperation } from '@wilson/sdk';
import { InlineImage } from '#src/components/InlineImage.js';
import { Markdown } from '#src/components/Markdown.js';

/** `list_cards` in `demo` → `list cards in demo`: an operation as a person would say it. */
const operationLabel = ({ name, project }: ChatOperation): string => `${name.replaceAll('_', ' ')}${project ? ` in ${project}` : ''}`;

/** Repeats of one read, gathered under the one label they share. */
const distinct = (operations: ChatOperation[]): { label: string; runs: ChatOperation[] }[] => {
    const byLabel = new Map<string, ChatOperation[]>();
    for (const operation of operations) {
        const label = operationLabel(operation);
        byLabel.set(label, [...(byLabel.get(label) ?? []), operation]);
    }
    return [...byLabel].map(([label, runs]) => ({ label, runs }));
};

/** What the chat ran to say what it said; hover one for its arguments. A failed one shows red. */
export function ActivityLine({ operations }: { operations: ChatOperation[] }) {
    if (operations.length === 0) return null;
    return (
        <Group gap={6} wrap="nowrap" align="flex-start" c="dimmed">
            <IconBolt size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
            <Group gap={6}>
                {distinct(operations).map(({ label, runs }, index) => (
                    <Fragment key={label}>
                        {index > 0 && (
                            <Text size="xs" aria-hidden>
                                ·
                            </Text>
                        )}
                        <Tooltip label={runs.map(run => JSON.stringify(run.arguments)).join('\n')} style={{ whiteSpace: 'pre-wrap' }}>
                            <Text size="xs" c={runs.every(run => run.ok) ? undefined : 'red'}>
                                {label}
                            </Text>
                        </Tooltip>
                    </Fragment>
                ))}
            </Group>
        </Group>
    );
}

/** Where a thread's attachment is served, which is also the URL its markdown would embed it by. */
const attachmentUrl = (threadId: string, attachment: ChatAttachment): string => `/api/chat/threads/${threadId}/attachments/${attachment.id}`;

/** What the person wrote: a pill on the right, against the answers running the column's full width. */
export function UserMessage({ text, threadId, attachments = [] }: { text: string; threadId: string | undefined; attachments?: ChatAttachment[] }) {
    return (
        <Group justify="flex-end">
            <Paper px="md" py={8} radius="lg" maw="85%" style={{ background: 'var(--mantine-color-default-hover)' }}>
                {threadId && attachments.length > 0 && (
                    <Group gap="xs">
                        {attachments.map(attachment => (
                            <InlineImage key={attachment.id} url={attachmentUrl(threadId, attachment)} alt={attachment.filename} />
                        ))}
                    </Group>
                )}
                <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {text}
                </Text>
            </Paper>
        </Group>
    );
}

/** An answer: what it ran, then what it said, with no box around either. */
export function AssistantMessage({
    text,
    operations,
    threadId,
    attachments = [],
}: {
    text: string;
    operations: ChatOperation[];
    threadId: string | undefined;
    attachments?: ChatAttachment[];
}) {
    // An image the answer carries but never embedded is drawn below it, so a picture Wilson made and
    // forgot to link is shown rather than silently lost; one it did embed is not drawn twice.
    const unembedded = threadId
        ? attachments.map(attachment => ({ attachment, url: attachmentUrl(threadId, attachment) })).filter(({ url }) => !text.includes(url))
        : [];
    return (
        <Box style={{ overflowWrap: 'anywhere' }}>
            <ActivityLine operations={operations} />
            {text && (
                <Box mt={operations.length > 0 ? 'xs' : 0}>
                    <Markdown body={text} />
                </Box>
            )}
            {unembedded.length > 0 && (
                <Group gap="xs" mt="xs">
                    {unembedded.map(({ attachment, url }) => (
                        <InlineImage key={attachment.id} url={url} alt={attachment.filename} />
                    ))}
                </Group>
            )}
        </Box>
    );
}

export function Message({ message, threadId }: { message: ChatMessage; threadId: string | undefined }) {
    return message.role === 'user' ? (
        <UserMessage text={message.content} threadId={threadId} attachments={message.attachments} />
    ) : (
        <AssistantMessage text={message.content} operations={message.operations} threadId={threadId} attachments={message.attachments} />
    );
}

/** The answer in progress: what it has run and written so far, and that it is still going until it writes. */
export function AnswerInProgress({ text, operations, threadId }: { text: string; operations: ChatOperation[]; threadId: string | undefined }) {
    return (
        // Read out once it is stored, not word by word.
        <Box aria-busy="true">
            <AssistantMessage text={text} operations={operations} threadId={threadId} />
            {!text && (
                <Group gap="xs" c="dimmed" mt={operations.length > 0 ? 'xs' : 0}>
                    <Loader type="dots" size="sm" />
                    <Text size="sm">Working on it…</Text>
                </Group>
            )}
        </Box>
    );
}
