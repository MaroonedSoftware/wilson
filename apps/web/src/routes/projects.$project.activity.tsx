import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Alert, Loader, Stack, Title } from '@mantine/core';
import { ActivityFeed } from '#src/components/ActivityFeed.js';
import { activityQueryKey } from '#src/lib/feed.js';
import { wilsonForProject } from '#src/lib/sdk.js';
import { AnchorLink } from '#src/lib/router-link.js';

/** How many events one read fetches. A shorter page than this is the end of the history. */
const PAGE_SIZE = 50;

/**
 * What is happening across one project, newest first. `useCardFeed` keeps it live by invalidating
 * this query on each event, the same way it keeps the board fresh, so this route holds no
 * subscription of its own.
 */
function ProjectActivityRoute() {
    const { project } = Route.useParams();
    const client = useMemo(() => wilsonForProject(project), [project]);

    const activity = useInfiniteQuery({
        queryKey: activityQueryKey(project),
        queryFn: ({ pageParam }) => client.board.listProjectActivity({ limit: PAGE_SIZE, before: pageParam }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: lastPage => (lastPage.length < PAGE_SIZE ? undefined : Number(lastPage[lastPage.length - 1]!.id)),
    });

    if (activity.error) {
        return (
            <Alert color="red" title="Cannot reach the API">
                {activity.error.message}
            </Alert>
        );
    }

    return (
        <Stack gap="md">
            <AnchorLink to="/projects/$project" params={{ project }} size="sm">
                ← Back to the board
            </AnchorLink>
            <Title order={4} fw={500}>
                Activity
            </Title>
            {activity.data ? (
                <ActivityFeed
                    project={project}
                    events={activity.data.pages.flat()}
                    hasMore={activity.hasNextPage}
                    loadingMore={activity.isFetchingNextPage}
                    onLoadMore={() => void activity.fetchNextPage()}
                />
            ) : (
                <Loader size="sm" />
            )}
        </Stack>
    );
}

export const Route = createFileRoute('/projects/$project/activity')({ component: ProjectActivityRoute });
