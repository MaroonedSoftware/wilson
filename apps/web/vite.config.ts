import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

export default defineConfig({
    plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react()],
    resolve: {
        alias: {
            '#src': new URL('./src/', import.meta.url).pathname,
            // Resolve the SDK from source so a regenerated contract is picked up immediately,
            // without a package build in between. The SDK is generated output either way.
            '@wilson/sdk': new URL('../../packages/sdk/src/index.ts', import.meta.url).pathname,
        },
    },
    server: {
        // No proxy. The API admits this origin with credentials (`WEB_ORIGINS`,
        // apps/api/src/server/setup.middleware.ts), so the SDK talks to it directly.
        port: 13101,
    },
});
