import { Fragment } from 'react';
import { Box, Group, Loader, Paper, Text, Tooltip } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import type { ChatMessage, ChatOperation } from '@wilson/sdk';
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

/** What the person wrote: a pill on the right, against the answers running the column's full width. */
export function UserMessage({ text }: { text: string }) {
    return (
        <Group justify="flex-end">
            <Paper px="md" py={8} radius="lg" maw="85%" style={{ background: 'var(--mantine-color-default-hover)' }}>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {text}
                </Text>
            </Paper>
        </Group>
    );
}

/** An answer: what it ran, then what it said, with no box around either. */
export function AssistantMessage({ text, operations }: { text: string; operations: ChatOperation[] }) {
    return (
        <Box style={{ overflowWrap: 'anywhere' }}>
            <ActivityLine operations={operations} />
            {text && (
                <Box mt={operations.length > 0 ? 'xs' : 0}>
                    <Markdown body={text} />
                </Box>
            )}
        </Box>
    );
}

export function Message({ message }: { message: ChatMessage }) {
    return message.role === 'user' ? (
        <UserMessage text={message.content} />
    ) : (
        <AssistantMessage text={message.content} operations={message.operations} />
    );
}

/** The answer in progress: what it has run and written so far, and that it is still going until it writes. */
export function AnswerInProgress({ text, operations }: { text: string; operations: ChatOperation[] }) {
    return (
        // Read out once it is stored, not word by word.
        <Box aria-busy="true">
            <AssistantMessage text={text} operations={operations} />
            {!text && (
                <Group gap="xs" c="dimmed" mt={operations.length > 0 ? 'xs' : 0}>
                    <Loader type="dots" size="sm" />
                    <Text size="sm">Working on it…</Text>
                </Group>
            )}
        </Box>
    );
}
