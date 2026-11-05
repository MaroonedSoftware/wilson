import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Loader, Stack, Title } from '@mantine/core';
import { AppFrame } from '#src/components/AppFrame.js';
import { AnchorLink } from '#src/lib/router-link.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

/** The header and the shell's padding, top and bottom, which the app's page has to fit under. */
const SHELL_OFFSET = 'calc(48px + 2 * var(--mantine-spacing-md))';

/**
 * One installed app, open in one project. Apps are installed once for the whole server, and the URL
 * is what says which project this one is looking at. Keyed on `updatedAt` so a replaced app starts
 * again in a new frame, rather than loading into the old one and looking as if it had navigated.
 */
function ProjectAppRoute() {
    const { project, slug } = Route.useParams();
    const sdk = useWilsonSdk();
    const app = useQuery({ queryKey: ['apps', slug], queryFn: () => sdk.apps.getApp(slug) });

    return (
        <Stack gap="sm" h={`calc(100dvh - ${SHELL_OFFSET})`}>
            <AnchorLink to="/projects/$project" params={{ project }} size="sm">
                ← Back to the board
            </AnchorLink>
            {app.error && (
                <Alert color="red" title={(app.error as { status?: number }).status === 404 ? `No app "${slug}"` : 'Cannot reach the API'}>
                    {(app.error as { status?: number }).status === 404
                        ? 'It may have been removed. Apps are installed in Settings.'
                        : app.error.message}
                </Alert>
            )}
            {app.isPending && <Loader size="sm" />}
            {app.data && (
                <>
                    <Title order={4} fw={500}>
                        {app.data.name}
                    </Title>
                    <AppFrame key={app.data.updatedAt.toMillis()} name={app.data.name} html={app.data.html} />
                </>
            )}
        </Stack>
    );
}

export const Route = createFileRoute('/projects/$project/apps/$slug')({ component: ProjectAppRoute });
