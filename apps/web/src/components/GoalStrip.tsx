import { Badge, Group, Text } from '@mantine/core';
import { IconTarget } from '@tabler/icons-react';
import { statusColor, useThreadGoal } from '#src/lib/goals.js';
import { AnchorLink } from '#src/lib/router-link.js';

/** Says which goal a thread sees through, above its conversation. Nothing for a thread without one. */
export function GoalStrip({ threadId }: { threadId: string | undefined }) {
    const { data: goal } = useThreadGoal(threadId);
    if (!goal) return null;
    return (
        <Group
            gap="xs"
            px="md"
            py={6}
            wrap="nowrap"
            aria-label="This thread's goal"
            style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
        >
            <IconTarget size={16} aria-hidden />
            <AnchorLink to="/goals/$goalId" params={{ goalId: goal.id }} size="sm" truncate>
                {goal.title}
            </AnchorLink>
            <Badge size="xs" variant="light" color={statusColor(goal.status)}>
                {goal.status}
            </Badge>
            <Text size="xs" c="dimmed" visibleFrom="sm">
                {goal.project}
            </Text>
        </Group>
    );
}
