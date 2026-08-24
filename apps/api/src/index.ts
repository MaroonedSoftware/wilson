import 'reflect-metadata';
import { setupServer } from './server/setup.server.js';

/**
 * The HTTP server entrypoint.
 *
 * `reflect-metadata` has its one obvious home here, imported before anything that uses
 * decorators. `setupServer()` wires the same modules the CLI boots (`cli-bootstrap.ts`), plus the
 * HTTP layer on top.
 */
await setupServer();
