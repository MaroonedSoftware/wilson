import { readFileSync } from 'node:fs';
import { WorkerClient, WorkerStoppedError } from './worker.client.js';

/**
 * The worker program: `pnpm --filter @wilson/worker start` on a machine kept for running Wilson's
 * stages. Configured by its environment alone:
 *
 * - `WILSON_URL` (required): Wilson's API, e.g. `http://tower:13100`.
 * - `WILSON_WORKER_TOKEN` (required): this host's token, from `wilson host token <name>`.
 * - `CLAUDE_CODE_OAUTH_TOKEN`: what the engine signs in with here (from `claude setup-token`). Unset,
 *   the engine uses this machine's own `claude` sign-in, if it has one.
 * - `WILSON_CLAUDE`: the `claude` binary, when it is not the one on `PATH`.
 *
 * Exits 1 when Wilson refuses this worker for good (a bad token, another protocol version, or a second
 * worker for the same host); a process supervisor restarting it would only be refused again.
 */
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) {
        console.error(`${name} is not set; see apps/worker/src/main.ts for what the worker needs`);
        process.exit(2);
    }
    return value;
};

const log = (level: string) => (message: string) => console.log(`${new Date().toISOString()} ${level} ${message}`);

const client = new WorkerClient({
    url: required('WILSON_URL'),
    token: required('WILSON_WORKER_TOKEN'),
    version,
    executor: { ...(process.env.WILSON_CLAUDE && { claudeCommand: process.env.WILSON_CLAUDE }) },
    logger: { info: log('info'), warn: log('warn'), error: log('error') },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => client.stop());
}

console.log(`${new Date().toISOString()} info wilson worker ${version} connecting to ${process.env.WILSON_URL}`);
try {
    await client.run();
    process.exit(0);
} catch (err) {
    process.exit(err instanceof WorkerStoppedError ? 1 : 3);
}
