import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Alert, Badge, Button, Group, Paper, Skeleton, Stack, Text, Title } from '@mantine/core';
import type { Goal } from '@wilson/sdk';
import { setActiveThread } from '#src/lib/chat.js';
import { statusColor, useGoal, useUpdateGoal } from '#src/lib/goals.js';
import { reasonFor } from '#src/lib/mutations.js';
import { AnchorLink } from '#src/lib/router-link.js';

/** What a person can do with a goal in each status: the status each button moves it to, and what it says. */
export const STATUS_ACTIONS: Record<Goal['status'], { to: Goal['status']; label: string }[]> = {
    active: [
        { to: 'paused', label: 'Pause' },
        { to: 'done', label: 'Mark done' },
        { to: 'abandoned', label: 'Abandon' },
    ],
    paused: [
        { to: 'active', label: 'Resume' },
        { to: 'done', label: 'Mark done' },
        { to: 'abandoned', label: 'Abandon' },
    ],
    done: [{ to: 'active', label: 'Reopen' }],
    abandoned: [{ to: 'active', label: 'Reopen' }],
};

/** `/goals/$goalId`: one goal, its cards, and the conversation seeing it through. */
function GoalRoute() {
    const { goalId } = Route.useParams();
    const navigate = useNavigate();
    const detail = useGoal(goalId);
    const update = useUpdateGoal(goalId);

    if (detail.isLoading) return <Skeleton height={120} />;
    if (!detail.data) return <Alert color="red">{detail.error ? reasonFor(detail.error) : 'This goal could not be read.'}</Alert>;
    const { goal, cards } = detail.data;

    const openConversation = () => {
        setActiveThread(goal.threadId);
        void navigate({ to: '/' });
    };

    return (
        <Stack gap="md" maw={880} mx="auto">
            <AnchorLink to="/goals" size="sm">
                All goals
            </AnchorLink>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={4} style={{ minWidth: 0 }}>
                    <Group gap="xs">
                        <Title order={3}>{goal.title}</Title>
                        <Badge variant="light" color={statusColor(goal.status)}>
                            {goal.status}
                        </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">
                        {goal.project}
                    </Text>
                </Stack>
                <Button variant="light" size="xs" onClick={openConversation} style={{ flexShrink: 0 }}>
                    Open conversation
                </Button>
            </Group>
            <Stack gap={4}>
                <Title order={5}>What done looks like</Title>
                <Text style={{ whiteSpace: 'pre-wrap' }}>{goal.outcome}</Text>
            </Stack>
            <Group gap="xs">
                {STATUS_ACTIONS[goal.status].map(({ to, label }) => (
                    <Button key={to} size="xs" variant="default" loading={update.isPending} onClick={() => update.mutate({ status: to })}>
                        {label}
                    </Button>
                ))}
            </Group>
            {update.error && <Alert color="red">{reasonFor(update.error)}</Alert>}
            <Stack gap="xs">
                <Title order={5}>Cards</Title>
                {cards.length === 0 && <Text c="dimmed">No cards yet. Ask in the conversation to add some.</Text>}
                {cards.map(card => (
                    <Paper key={card.id} withBorder p="xs" aria-label={`card ${card.id}`}>
                        <Group justify="space-between" gap="xs">
                            <AnchorLink to="/projects/$project/cards/$cardId" params={{ project: goal.project, cardId: card.id }}>
                                {card.id} {card.title}
                            </AnchorLink>
                            <Group gap="xs" wrap="nowrap">
                                {card.needsHuman && (
                                    <Badge color="red" variant="light">
                                        needs you
                                    </Badge>
                                )}
                                <Badge variant="outline" color="gray">
                                    {card.stage}
                                </Badge>
                            </Group>
                        </Group>
                    </Paper>
                ))}
            </Stack>
        </Stack>
    );
}

export const Route = createFileRoute('/goals/$goalId')({ component: GoalRoute });
