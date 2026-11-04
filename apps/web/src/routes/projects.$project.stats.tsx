import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Alert, Group, Loader, SegmentedControl, Stack, Title } from '@mantine/core';
import { ProjectStats } from '#src/components/ProjectStats.js';
import { statsQueryKey } from '#src/lib/feed.js';
import { wilsonForProject } from '#src/lib/sdk.js';
import { AnchorLink } from '#src/lib/router-link.js';

const WINDOWS = ['7', '30', '90'];

/**
 * What one project has spent over the last while. `useCardFeed` keeps it live by invalidating this
 * query on each event, the same way it keeps the activity page fresh.
 */
function ProjectStatsRoute() {
    const { project } = Route.useParams();
    const client = useMemo(() => wilsonForProject(project), [project]);
    const [days, setDays] = useState('30');

    const stats = useQuery({
        queryKey: [...statsQueryKey(project), days],
        // Together, since the page's figures are compared: the pass rate subtracts the gates' revises.
        queryFn: async () => {
            const query = { days: Number(days) };
            const [figures, gates] = await Promise.all([client.board.getProjectStats(query), client.board.getProjectGateStats(query)]);
            return { figures, gates };
        },
        placeholderData: keepPreviousData,
    });

    if (stats.error) {
        return (
            <Alert color="red" title="Cannot reach the API">
                {stats.error.message}
            </Alert>
        );
    }

    return (
        <Stack gap="md">
            <AnchorLink to="/projects/$project" params={{ project }} size="sm">
                ← Back to the board
            </AnchorLink>
            <Group justify="space-between">
                <Title order={4} fw={500}>
                    Stats
                </Title>
                <SegmentedControl
                    size="xs"
                    aria-label="How many days to show"
                    value={days}
                    onChange={setDays}
                    data={WINDOWS.map(value => ({ value, label: `${value} days` }))}
                />
            </Group>
            {stats.data ? <ProjectStats project={project} stats={stats.data.figures} gates={stats.data.gates} /> : <Loader size="sm" />}
        </Stack>
    );
}

export const Route = createFileRoute('/projects/$project/stats')({ component: ProjectStatsRoute });
