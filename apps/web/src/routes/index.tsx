import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Loader, Paper, Stack, Title } from '@mantine/core';
import { listRegisteredProjects } from '#src/lib/projects.js';
import { AnchorLink } from '#src/lib/router-link.js';

/**
 * `/`: the dashboard (card 0169). Card 0155 deleted the route this restores, leaving nothing
 * between "load the app" and TanStack's own "Not Found" — `ProjectSwitcher` doesn't fill that gap,
 * since it renders nothing below two registered projects (`ProjectSwitcher.tsx`'s own doc comment)
 * and is a switcher for once you're already inside a project besides.
 *
 * `['registered-projects']` is `ProjectSwitcher`'s own query key, reused deliberately (this card's
 * Constraints) — both components ask `listRegisteredProjects` the same question, and two keys would
 * mean two fetches and two caches that can disagree on one screen.
 *
 * Names only, one `Paper` panel: `GET /api/projects` answers `{ name }` and nothing else (card
 * 0162), and a per-project stat would mean a `listCards()` fan-out per registered project — N
 * requests to render one screen, considered and rejected rather than deferred. The panel is its own
 * `Paper` rather than a bare list at the top of the viewport so a later card has an obvious place to
 * add a second one beside it, per this card's own instruction not to build that here.
 *
 * `AnchorLink` (`router-link.tsx`), not `component={Link}`: the target carries a `project` param,
 * and Mantine's polymorphic `component` prop erases TanStack's route-specific typing for that case.
 */
function DashboardRoute() {
    const projects = useQuery({ queryKey: ['registered-projects'], queryFn: listRegisteredProjects });

    return (
        <Stack gap="lg">
            <Title order={2}>Dashboard</Title>

            <Paper withBorder p="md" radius="sm">
                <Stack gap="sm">
                    <Title order={4}>Projects</Title>
                    {projects.error && (
                        <Alert color="red" title="Cannot reach the API">
                            {projects.error.message}
                        </Alert>
                    )}
                    {!projects.error && !projects.data && <Loader size="sm" />}
                    {projects.data && (
                        <Stack gap="xs">
                            {projects.data.map(project => (
                                <AnchorLink key={project.name} to="/projects/$project" params={{ project: project.name }}>
                                    {project.name}
                                </AnchorLink>
                            ))}
                        </Stack>
                    )}
                </Stack>
            </Paper>
        </Stack>
    );
}

export const Route = createFileRoute('/')({ component: DashboardRoute });
