import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider, localStorageColorSchemeManager } from '@mantine/core';

import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';

import { routeTree } from './routeTree.gen';
import { theme } from './theme';

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}

const queryClient = new QueryClient();

// `defaultColorScheme="auto"` plus a localStorage-backed manager, matching the inline script
// `index.html` carries for the pre-paint read (`ColorSchemeScript`'s own logic, hand-copied there
// since this card's Constraints rule out `ColorSchemeScript` itself — it renders too late, after
// React mounts, to avoid the flash it exists to prevent). Same default key
// (`mantine-color-scheme-value`) on both sides, or the two would read different values and disagree
// about which scheme is active the moment React takes over.
const colorSchemeManager = localStorageColorSchemeManager();

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

ReactDOM.createRoot(root).render(
    <StrictMode>
        <MantineProvider theme={theme} defaultColorScheme="auto" colorSchemeManager={colorSchemeManager}>
            <QueryClientProvider client={queryClient}>
                <RouterProvider router={router} />
            </QueryClientProvider>
        </MantineProvider>
    </StrictMode>,
);
