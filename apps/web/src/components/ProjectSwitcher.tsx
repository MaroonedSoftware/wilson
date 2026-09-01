import { useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { IconCheck, IconFolders } from '@tabler/icons-react';
import { useWilsonSdk } from '#src/lib/sdk-context.js';
import { listRegisteredProjects } from '#src/lib/projects.js';
import { AnchorLink } from '#src/lib/router-link.js';

/**
 * Lets a person move between registered projects (card 0154).
 *
 * Lists exactly what `GET /api/projects` (`lib/projects.js`) says is registered — never a name typed
 * or guessed — and marks whichever one is on screen right now: `useParams({ strict: false }).project`,
 * the same read `__root.tsx` already makes for the feed, naming a `/projects/$project/*` route's own
 * project; a top-level route carries no such param, so `health.project` (the daemon's own configured
 * project, `HealthClient.getHealth`, the same fallback `FlaggedIndicator` already uses) stands in for
 * it there instead.
 *
 * Switching is a navigation, never local state (this card's Constraints): picking another project
 * sends the browser to that project's own `/projects/$project` URL (`useNavigate`) — the board screen
 * already rendered there (`projects.$project.index.tsx`) — rather than setting a variable that would
 * leave the address bar naming one project while the screen shows another.
 *
 * Renders nothing while the registered projects are still loading. Card 0173: a single-project
 * deployment used to get nothing at all here, ever — with only one project there is nothing to
 * *switch* between, but there is still somewhere to go, so exactly one project renders a direct link
 * to that project's own board instead of the ≥2 menu below. `AnchorLink` (`lib/router-link.js`), not
 * `ActionIcon component={Link}`: the target is `/projects/$project`, a parameterised route, which is
 * exactly where that pattern erases TanStack's typed `params` (`router-link.tsx`'s own doc comment).
 * No `Tooltip` around it, unlike the ≥2-project trigger below: `AnchorLink` isn't itself
 * ref-forwarding the way a bare `ActionIcon` is, and the icon inside carries its own `aria-label`.
 */
export function ProjectSwitcher() {
    const wilson = useWilsonSdk();
    const navigate = useNavigate();
    const { project: routeProject } = useParams({ strict: false });
    const projects = useQuery({ queryKey: ['registered-projects'], queryFn: listRegisteredProjects });
    // Only needed to name the current project on a route that carries no `project` param of its own —
    // skipped entirely once a route param already answers the question.
    const health = useQuery({ queryKey: ['health'], queryFn: () => wilson.health.getHealth(), enabled: !routeProject });

    if (!projects.data || projects.data.length === 0) return null;

    if (projects.data.length === 1) {
        const project = projects.data[0];
        if (!project) return null;
        return (
            <AnchorLink to="/projects/$project" params={{ project: project.name }} aria-label="Go to the board" underline="never" c="inherit">
                <ActionIcon component="span" variant="subtle">
                    <IconFolders size={18} />
                </ActionIcon>
            </AnchorLink>
        );
    }

    const current = routeProject ?? health.data?.project;

    return (
        <Menu position="bottom-end" withArrow>
            <Menu.Target>
                <Tooltip label="Switch project">
                    <ActionIcon variant="subtle" aria-label="Switch project">
                        <IconFolders size={18} />
                    </ActionIcon>
                </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
                {projects.data.map(project => (
                    <Menu.Item
                        key={project.name}
                        leftSection={project.name === current ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
                        onClick={() => {
                            if (project.name === current) return;
                            void navigate({ to: '/projects/$project', params: { project: project.name } });
                        }}
                    >
                        {project.name}
                    </Menu.Item>
                ))}
            </Menu.Dropdown>
        </Menu>
    );
}
