import 'reflect-metadata';

/**
 * Step 0 has no server: the CLI is the only entrypoint (PROJECT.md, Bootstrapping).
 *
 * This file exists so the app has the shape it will need at step 6, when `setupServer()` joins the
 * same modules — and so `reflect-metadata` has one obvious home.
 */
throw new Error('The HTTP server lands at step 6. Until then, drive the runner through the CLI: `pnpm wizard card run <id>`.');
