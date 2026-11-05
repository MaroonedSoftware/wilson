import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { grantLabel } from '#src/lib/apps.js';
import { AnchorLink } from '#src/lib/router-link.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

/** The installed apps, each opening in this project. They are installed in Settings, for the whole server. */
function ProjectAppsRoute() {
    const { project } = Route.useParams();
    const sdk = useWilsonSdk();
    const apps = useQuery({ queryKey: ['apps'], queryFn: () => sdk.apps.listApps() });

    return (
        <Stack gap="md">
            <AnchorLink to="/projects/$project" params={{ project }} size="sm">
                ← Back to the board
            </AnchorLink>
            <Title order={4} fw={500}>
                Apps
            </Title>
            {apps.error && (
                <Alert color="red" title="Cannot reach the API">
                    {apps.error.message}
                </Alert>
            )}
            {apps.isPending && <Loader size="sm" />}
            {apps.data?.length === 0 && (
                <Text size="sm" c="dimmed">
                    No apps installed. You can install one in{' '}
                    <Link to="/settings" search={{ project }}>
                        Settings
                    </Link>
                    .
                </Text>
            )}
            {apps.data?.map(app => (
                <Paper key={app.slug} withBorder p="md" radius="sm">
                    <Stack gap={4}>
                        <AnchorLink to="/projects/$project/apps/$slug" params={{ project, slug: app.slug }} fw={500}>
                            {app.name}
                        </AnchorLink>
                        {app.description && (
                            <Text size="sm" c="dimmed">
                                {app.description}
                            </Text>
                        )}
                        <Group gap={4}>
                            {app.grants.map(grant => (
                                <Badge key={grant} size="xs" variant="light" color="gray">
                                    {grantLabel(grant)}
                                </Badge>
                            ))}
                        </Group>
                    </Stack>
                </Paper>
            ))}
        </Stack>
    );
}

export const Route = createFileRoute('/projects/$project/apps/')({ component: ProjectAppsRoute });
