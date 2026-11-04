import { Fragment, useState } from 'react';
import { Badge, Box, Button, Card, Code, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ChatPendingAction } from '@wilson/sdk';
import { useDecideChatAction } from '#src/lib/chat.js';
import { actionFields, prettyArguments, type ChatActionField } from '#src/lib/chat.arguments.js';
import { Markdown } from '#src/components/Markdown.js';
import { reasonFor } from '#src/lib/mutations.js';

const STATUS_COLOR: Record<ChatPendingAction['status'], string> = {
    pending: 'yellow',
    running: 'blue',
    done: 'green',
    failed: 'red',
    declined: 'gray',
};

/** Whether a proposal still waits on the person: past its expiry the server would refuse a confirm. */
export const isAwaiting = (action: ChatPendingAction): boolean => action.status === 'pending' && action.expiresAt.toMillis() > Date.now();

/** How tall a long value gets before it scrolls in its own box, so Confirm stays near the summary. */
const TALLEST_VALUE = 280;

const VALUE_BOX = {
    background: 'var(--mantine-color-default-hover)',
    borderRadius: 'var(--mantine-radius-sm)',
    padding: 'var(--mantine-spacing-xs)',
};

const Label = ({ children }: { children: string }) => (
    <Text size="xs" c="dimmed">
        {children}
    </Text>
);

/** The short values beside their labels, then anything long under its own. */
function Fields({ fields }: { fields: ChatActionField[] }) {
    const lines = fields.filter(field => field.kind === 'line');
    const blocks = fields.filter(field => field.kind !== 'line');
    return (
        <Stack gap="xs">
            {lines.length > 0 && (
                <Box
                    style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 'var(--mantine-spacing-sm)', rowGap: 4 }}
                >
                    {lines.map((field, index) => (
                        <Fragment key={index}>
                            <Label>{field.label}</Label>
                            <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                                {field.value}
                            </Text>
                        </Fragment>
                    ))}
                </Box>
            )}
            {blocks.map((field, index) => (
                <Stack key={index} gap={4}>
                    <Label>{field.label}</Label>
                    {field.kind === 'prose' ? (
                        <ScrollArea.Autosize mah={TALLEST_VALUE} style={VALUE_BOX}>
                            <Markdown body={field.value} />
                        </ScrollArea.Autosize>
                    ) : (
                        <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                            {field.value}
                        </Code>
                    )}
                </Stack>
            ))}
        </Stack>
    );
}

/**
 * A change the chat proposed. Only here does anything change: Confirm runs exactly the operation and
 * arguments shown, as the person's own act; Decline drops it. Past its expiry it can no longer be
 * confirmed, and says so rather than offering a button the server would refuse. Once decided it stays
 * in the conversation with how it went. Rendered Markdown can hide a link's address, so the arguments
 * as they will really be sent stay one press away.
 */
export function ChatActionCard({ action }: { action: ChatPendingAction }) {
    const decide = useDecideChatAction(action.threadId);
    const awaiting = isAwaiting(action);
    const expired = action.status === 'pending' && !awaiting;
    const [raw, setRaw] = useState(false);
    const fields = actionFields(action.arguments);

    return (
        <Card withBorder padding="md" radius="md" role="group" aria-label="Proposed change">
            <Stack gap="sm">
                <Group gap="xs" wrap="nowrap" align="flex-start">
                    {awaiting && (
                        <IconAlertTriangle size={18} color="var(--mantine-color-yellow-6)" aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                    )}
                    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <Text size="sm" fw={500}>
                            {action.summary}
                        </Text>
                        <Text size="xs" c="dimmed">
                            Runs <Code>{action.operation}</Code>
                            {action.project ? ` in ${action.project}` : ''} as you.
                            {awaiting ? ` Expires ${action.expiresAt.toRelative()}.` : ''}
                        </Text>
                    </Stack>
                    {!awaiting && (
                        <Badge size="xs" color={expired ? 'gray' : STATUS_COLOR[action.status]} variant="light" style={{ flexShrink: 0 }}>
                            {expired ? 'expired' : action.status}
                        </Badge>
                    )}
                </Group>
                {raw ? (
                    <ScrollArea.Autosize mah={TALLEST_VALUE}>
                        <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                            {prettyArguments(action.arguments)}
                        </Code>
                    </ScrollArea.Autosize>
                ) : (
                    <Fields fields={fields} />
                )}
                {(fields.length > 0 || awaiting) && (
                    <Group gap="xs" justify="space-between">
                        {fields.length > 0 ? (
                            <Button size="xs" variant="subtle" color="gray" aria-pressed={raw} onClick={() => setRaw(!raw)}>
                                {raw ? 'Show fields' : 'Show raw JSON'}
                            </Button>
                        ) : (
                            <span />
                        )}
                        {awaiting && (
                            <Group gap="xs">
                                <Button
                                    size="xs"
                                    variant="default"
                                    disabled={decide.isPending}
                                    onClick={() => decide.mutate({ actionId: action.id, decision: 'decline' })}
                                >
                                    Decline
                                </Button>
                                <Button
                                    size="xs"
                                    loading={decide.isPending}
                                    onClick={() => decide.mutate({ actionId: action.id, decision: 'confirm' })}
                                >
                                    Confirm
                                </Button>
                            </Group>
                        )}
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
        </Card>
    );
}
