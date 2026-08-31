import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Stack, Text, Title } from '@mantine/core';
import { Board } from '#src/components/Board.js';
import { BoardSkeleton } from '#src/components/BoardSkeleton.js';
import { wilsonForProject } from '#src/lib/sdk.js';
import { WilsonSdkProvider } from '#src/lib/sdk-context.js';
import { AnchorLink } from '#src/lib/router-link.js';

/**
 * Card 0153: `/flagged` (`flagged.tsx`) at a project-scoped URL, `/projects/$project/flagged` — same
 * reasoning as `projects.$project.index.tsx` beside this file: a client built for this route's own
 * `project` param, and query keys prefixed with it so this screen's cache never collides with
 * `/flagged`'s own unprefixed `['cards']`/`['columns']`.
 *
 * The "back to board" link needs `params` (`{ project }`), which is exactly where Mantine's
 * `component={Link}` erases TanStack's typing (this card's Constraints) — `AnchorLink`
 * (`lib/router-link.js`, `createLink(Anchor)`) is the chosen fix, used here instead.
 *
 * Card 0156: wraps its render tree in `WilsonSdkProvider` with `client`, matching
 * `projects.$project.index.tsx`.
 *
 * Card 0175: a cold load renders `BoardSkeleton` instead of a bare `Loader` in the pending branch,
 * matching the board route beside this file. This route gets the skeleton only, not a second text
 * filter — the flagged view is already a filter over the board.
 */
function ProjectFlaggedRoute() {
    const { project } = Route.useParams();
    const client = useMemo(() => wilsonForProject(project), [project]);

    const columns = useQuery({ queryKey: ['project', project, 'columns'], queryFn: () => client.board.listBoardColumns() });
    const cards = useQuery({ queryKey: ['project', project, 'cards'], queryFn: () => client.board.listCards() });

    const error = columns.error ?? cards.error;
    if (error) {
        return (
            <Alert color="red" title="Cannot reach the API">
                {error.message}
            </Alert>
        );
    }
    if (!columns.data || !cards.data) return <BoardSkeleton />;

    const flagged = cards.data.filter(card => card.needsHuman);
    const flaggedStages = new Set(flagged.map(card => card.stage));
    const stagesWithFlagged = {
        stages: columns.data.stages.filter(stage => flaggedStages.has(stage)),
        nonStages: columns.data.nonStages.filter(stage => flaggedStages.has(stage)),
    };

    return (
        <WilsonSdkProvider client={client}>
            <Stack gap="md">
                <AnchorLink to="/projects/$project" params={{ project }} size="sm">
                    ← Back to the board
                </AnchorLink>
                <Title order={4} fw={500}>
                    Cards needing a human
                </Title>
                {flagged.length === 0 ? (
                    <Text c="dimmed" size="sm">
                        Nothing is flagged right now.
                    </Text>
                ) : (
                    <Board columns={stagesWithFlagged} cards={flagged} allCards={cards.data} project={project} />
                )}
            </Stack>
        </WilsonSdkProvider>
    );
}

export const Route = createFileRoute('/projects/$project/flagged')({ component: ProjectFlaggedRoute });
