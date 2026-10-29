import type { ExecOptions, ExecResult, ExecutionHost, HostStat } from '#modules/host/execution.host.js';

/**
 * A host with no disk behind it: files live in a map and commands are recorded, not run. Tests
 * point it at a worktree root that does not exist on this machine, so code that reached for
 * `node:fs` or `execFile` directly instead of the host it was given fails rather than passes by
 * accident.
 *
 * `respond` decides what a command prints; by default every command succeeds with `ran <file>`.
 */
export class MemoryHost implements ExecutionHost {
    readonly name = 'memory';
    readonly files = new Map<string, string>();
    readonly dirs = new Set<string>();
    readonly commands: { file: string; args: readonly string[]; options: ExecOptions }[] = [];

    constructor(private readonly respond: (file: string, args: readonly string[]) => ExecResult = file => ({ stdout: `ran ${file}`, stderr: '' })) {}

    async readFile(path: string): Promise<string> {
        const content = this.files.get(path);
        if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
        return content;
    }

    async writeFile(path: string, content: string): Promise<void> {
        this.files.set(path, content);
    }

    async mkdir(path: string): Promise<void> {
        this.dirs.add(path);
    }

    async stat(path: string): Promise<HostStat> {
        if (this.dirs.has(path)) return { isDirectory: true, mtimeMs: 0 };
        if (this.files.has(path)) return { isDirectory: false, mtimeMs: 0 };
        throw new Error(`ENOENT: no such file, stat '${path}'`);
    }

    async realpath(path: string): Promise<string> {
        return path;
    }

    async copyFile(from: string, to: string): Promise<void> {
        this.files.set(to, await this.readFile(from));
    }

    async unlink(path: string): Promise<void> {
        this.files.delete(path);
    }

    async removeTree(path: string): Promise<void> {
        for (const key of [...this.files.keys()]) if (key.startsWith(`${path}/`)) this.files.delete(key);
    }

    async exec(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
        this.commands.push({ file, args, options });
        return this.respond(file, args);
    }
}
