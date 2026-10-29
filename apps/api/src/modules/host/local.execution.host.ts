import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ExecOptions, ExecResult, ExecutionHost } from './execution.host.js';

const exec = promisify(execFile);

/**
 * The daemon's own machine: each method is the `node:fs/promises` or `node:child_process` call it
 * names, with nothing added, so routing a caller through this host changes nothing about what it
 * does.
 */
export class LocalHost implements ExecutionHost {
    readonly name = 'local';

    readFile(path: string): Promise<string> {
        return readFile(path, 'utf8');
    }

    writeFile(path: string, content: string): Promise<void> {
        return writeFile(path, content, 'utf8');
    }

    async mkdir(path: string): Promise<void> {
        await mkdir(path, { recursive: true });
    }

    async stat(path: string): Promise<{ isDirectory: boolean }> {
        const info = await stat(path);
        return { isDirectory: info.isDirectory() };
    }

    unlink(path: string): Promise<void> {
        return unlink(path);
    }

    removeTree(path: string): Promise<void> {
        return rm(path, { recursive: true, force: true });
    }

    async exec(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
        // Only the options a caller set. `execFile` spreads what it is given over its own defaults, so
        // an explicit `maxBuffer: undefined` would replace its 1 MiB cap with no cap at all.
        const { stdout, stderr } = await exec(file, args, {
            cwd: options.cwd,
            ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
            ...(options.maxBuffer !== undefined && { maxBuffer: options.maxBuffer }),
            ...(options.env !== undefined && { env: options.env }),
        });
        return { stdout, stderr };
    }
}

/** The one `LocalHost`; it holds no state, so nothing needs a second. */
export const localHost: ExecutionHost = new LocalHost();
