import { createFileRoute } from '@tanstack/react-router';
import { Alert, Badge, Group, Paper, Skeleton, Stack, Text, Title } from '@mantine/core';
import type { Goal } from '@wilson/sdk';
import { isOpen, statusColor, useGoals } from '#src/lib/goals.js';
import { reasonFor } from '#src/lib/mutations.js';
import { AnchorLink } from '#src/lib/router-link.js';

function GoalRow({ goal }: { goal: Goal }) {
    return (
        <Paper withBorder p="sm" aria-label={`goal ${goal.title}`}>
            <Group justify="space-between" wrap="nowrap">
                <Stack gap={2} style={{ minWidth: 0 }}>
                    <AnchorLink to="/goals/$goalId" params={{ goalId: goal.id }} fw={500} truncate>
                        {goal.title}
                    </AnchorLink>
                    <Text size="sm" c="dimmed" lineClamp={2}>
                        {goal.outcome}
                    </Text>
                </Stack>
                <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
                    <Text size="xs" c="dimmed" visibleFrom="sm">
                        {goal.project}
                    </Text>
                    <Badge variant="light" color={statusColor(goal.status)}>
                        {goal.status}
                    </Badge>
                </Group>
            </Group>
        </Paper>
    );
}

/** `/goals`: what the chat is seeing through, across every project, with what is still open first. */
function GoalsRoute() {
    const goals = useGoals();
    const open = goals.data?.filter(isOpen) ?? [];
    const finished = goals.data?.filter(goal => !isOpen(goal)) ?? [];

    return (
        <Stack gap="md" maw={880} mx="auto">
            <Title order={3}>Goals</Title>
            {goals.isLoading && <Skeleton height={64} />}
            {goals.isError && <Alert color="red">{reasonFor(goals.error)}</Alert>}
            {goals.data?.length === 0 && <Text c="dimmed">No goals yet. Ask the chat to start one for work that will take several cards.</Text>}
            {open.map(goal => (
                <GoalRow key={goal.id} goal={goal} />
            ))}
            {finished.length > 0 && (
                <>
                    <Title order={5} c="dimmed">
                        Finished
                    </Title>
                    {finished.map(goal => (
                        <GoalRow key={goal.id} goal={goal} />
                    ))}
                </>
            )}
        </Stack>
    );
}

export const Route = createFileRoute('/goals/')({ component: GoalsRoute });
