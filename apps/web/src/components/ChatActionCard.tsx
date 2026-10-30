import { Badge, Button, Card, Code, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ChatPendingAction } from '@wilson/sdk';
import { useDecideChatAction } from '#src/lib/chat.js';
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

/**
 * A change the chat proposed. Only here does anything change: Confirm runs exactly the operation and
 * arguments shown, as the person's own act; Decline drops it. Past its expiry it can no longer be
 * confirmed, and says so rather than offering a button the server would refuse. Once decided it stays
 * in the conversation with how it went.
 */
export function ChatActionCard({ action }: { action: ChatPendingAction }) {
    const decide = useDecideChatAction(action.threadId);
    const awaiting = isAwaiting(action);
    const expired = action.status === 'pending' && !awaiting;

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
                <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {JSON.stringify(action.arguments)}
                </Code>
                {awaiting && (
                    <Group gap="xs" justify="flex-end">
                        <Button
                            size="xs"
                            variant="default"
                            disabled={decide.isPending}
                            onClick={() => decide.mutate({ actionId: action.id, decision: 'decline' })}
                        >
                            Decline
                        </Button>
                        <Button size="xs" loading={decide.isPending} onClick={() => decide.mutate({ actionId: action.id, decision: 'confirm' })}>
                            Confirm
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
        </Card>
    );
}
