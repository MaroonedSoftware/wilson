import { useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Code, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { AppGrant, ChatPendingAction } from '@wilson/sdk';
import { isAwaiting } from '#src/components/ChatActionCard.js';
import { APP_GRANTS, grantLabel, type ProposedApp } from '#src/lib/apps.js';
import { useDecideChatAction } from '#src/lib/chat.js';
import { reasonFor } from '#src/lib/mutations.js';

/** How tall the source gets before it scrolls in its own box, so the grants and Confirm stay in reach. */
const TALLEST_SOURCE = 280;

const STATUS_COLOR: Record<ChatPendingAction['status'], string> = {
    pending: 'yellow',
    running: 'blue',
    done: 'green',
    failed: 'red',
    declined: 'gray',
};

const sizeOf = (html: string): string => `${Math.ceil(new TextEncoder().encode(html).length / 1024)} KiB`;

const installedGrants = (result: ChatPendingAction['result']): string[] => {
    const grants = (result as { grants?: unknown } | undefined)?.grants;
    return Array.isArray(grants) ? (grants as AppGrant[]).map(grantLabel) : [];
};

/**
 * An operator app the chat wrote and wants installed. The person reads its source and ticks what it
 * may read, and nothing starts ticked, whatever the chat asked for. Text the chat read may have steered
 * what it wrote, so this review is the defence, and the source is shown as literal text rather than
 * through Markdown, which would not show HTML faithfully. Confirm asks for a recent sign-in through the
 * usual dialog, and the action keeps waiting until that passes.
 */
export function ChatAppProposalCard({ action, app }: { action: ChatPendingAction; app: ProposedApp }) {
    const decide = useDecideChatAction(action.threadId);
    const [grants, setGrants] = useState<AppGrant[]>([]);
    const awaiting = isAwaiting(action);
    const expired = action.status === 'pending' && !awaiting;
    const granted = installedGrants(action.result);

    return (
        <Card withBorder padding="md" radius="md" role="group" aria-label="Proposed app">
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
                            A new app, <Code>{app.slug}</Code>, {sizeOf(app.html)}, for the whole server.
                            {awaiting ? ` Expires ${action.expiresAt.toRelative()}.` : ''}
                        </Text>
                    </Stack>
                    {!awaiting && (
                        <Badge size="xs" color={expired ? 'gray' : STATUS_COLOR[action.status]} variant="light" style={{ flexShrink: 0 }}>
                            {expired ? 'expired' : action.status}
                        </Badge>
                    )}
                </Group>
                {app.description && <Text size="sm">{app.description}</Text>}
                <Stack gap={4}>
                    <Text size="xs" c="dimmed">
                        Source
                    </Text>
                    <ScrollArea.Autosize mah={TALLEST_SOURCE}>
                        <Code block aria-label="App source" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                            {app.html}
                        </Code>
                    </ScrollArea.Autosize>
                </Stack>
                {awaiting && (
                    <>
                        <Checkbox.Group label="What it can read" value={grants} onChange={next => setGrants(next as AppGrant[])}>
                            <Stack gap="xs" mt="xs">
                                {APP_GRANTS.map(({ grant, label, detail }) => (
                                    <Checkbox
                                        key={grant}
                                        value={grant}
                                        label={app.requestedGrants.includes(grant) ? `${label} (the chat asks for this)` : label}
                                        description={detail}
                                    />
                                ))}
                            </Stack>
                        </Checkbox.Group>
                        <Alert color="yellow" title="What you tick could leave">
                            An app can send what it reads to a server it names. Your session and anything you do not tick stay out of its reach. The
                            chat wrote this, and what it read may have steered it, so check the source before you confirm.
                        </Alert>
                        <Group gap="xs" justify="flex-end">
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
                                onClick={() => decide.mutate({ actionId: action.id, decision: 'confirm', grants })}
                            >
                                Install
                            </Button>
                        </Group>
                    </>
                )}
                {action.status === 'done' && (
                    <Text size="xs" c="dimmed">
                        Installed, under Apps in any project's header. It can read: {granted.length > 0 ? granted.join(', ') : 'nothing'}.
                    </Text>
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
