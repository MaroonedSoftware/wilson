import { describe, expect, it } from 'vitest';
import { bashTool } from '#modules/agent/tools/bash.tool.js';
import { deleteFile } from '#modules/agent/tools/delete.tool.js';
import { fileTools } from '#modules/agent/tools/file.tools.js';
import { searchTools } from '#modules/agent/tools/search.tools.js';
import { toolHost, type ToolContext } from '#modules/agent/tools/tool.context.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import type { ExecutionHost } from '#modules/host/execution.host.js';
import { localHost } from '#modules/host/local.execution.host.js';
import { MemoryHost } from '#tests/support/memory.host.js';

type ExecuteFn<Input> = (input: Input) => Promise<string>;

const ROOT = '/remote/agent-3/worktrees/0001';

const buildContext = (host?: ExecutionHost): ToolContext =>
    ({
        project: 'p',
        cardId: '0001',
        stage: 'implementing',
        worktreeRoot: ROOT,
        // Allows everything: what is under test is where the work goes, not whether it is allowed.
        scope: {
            check: async (path: string) => ({ allowed: true, path }),
            checkRead: async (path: string) => ({ allowed: true, path }),
        },
        commands: new CommandAllowlist(['pnpm build']),
        scopeViolationPolicy: 'widen',
        events: { append: async () => {} },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        host,
    }) as unknown as ToolContext;

describe('stage tools run through their context’s host', () => {
    it('defaults to this machine when the context names no host', () => {
        expect(toolHost(buildContext())).toBe(localHost);
    });

    it('writes, reads and edits files on the host, under the worktree root', async () => {
        const host = new MemoryHost();
        const tools = fileTools(buildContext(host));

        await (tools.write.execute as unknown as ExecuteFn<{ path: string; content: string }>)({ path: 'src/a.ts', content: 'one\ntwo' });
        expect(host.dirs).toContain(`${ROOT}/src`);
        expect(host.files.get(`${ROOT}/src/a.ts`)).toBe('one\ntwo');

        const read = await (tools.read.execute as unknown as ExecuteFn<{ path: string }>)({ path: 'src/a.ts' });
        expect(read).toBe('1\tone\n2\ttwo');

        const edited = await (tools.edit.execute as unknown as ExecuteFn<{ path: string; old_string: string; new_string: string }>)({
            path: 'src/a.ts',
            old_string: 'two',
            new_string: 'three',
        });
        expect(edited).toContain('1 replacement');
        expect(host.files.get(`${ROOT}/src/a.ts`)).toBe('one\nthree');
    });

    it('deletes a file on the host, and refuses a directory there', async () => {
        const host = new MemoryHost();
        host.files.set(`${ROOT}/src/gone.ts`, 'x');
        host.dirs.add(`${ROOT}/src`);

        expect(await deleteFile(buildContext(host), 'src/gone.ts')).toBe('deleted src/gone.ts');
        expect(host.files.has(`${ROOT}/src/gone.ts`)).toBe(false);
        expect(await deleteFile(buildContext(host), 'src')).toContain('is a directory');
    });

    it('runs an allowed command on the host, in the worktree, with the scrubbed env', async () => {
        const host = new MemoryHost();
        const bash = bashTool({ ...buildContext(host), port: 4100 });

        const output = await (bash.execute as unknown as ExecuteFn<{ command: string }>)({ command: 'pnpm build' });

        expect(output).toBe('ran pnpm');
        expect(host.commands).toHaveLength(1);
        expect(host.commands[0]).toMatchObject({ file: 'pnpm', args: ['build'], options: { cwd: ROOT, timeoutMs: 5 * 60 * 1000 } });
        expect(host.commands[0]!.options.env?.PORT).toBe('4100');
    });

    it('searches with git on the host', async () => {
        const host = new MemoryHost();
        const tools = searchTools(buildContext(host));

        await (tools.glob.execute as unknown as ExecuteFn<{ pattern: string }>)({ pattern: 'src/**/*.ts' });
        await (tools.grep.execute as unknown as ExecuteFn<{ pattern: string }>)({ pattern: 'TODO' });

        expect(host.commands.map(c => [c.file, c.args[0], c.options.cwd])).toEqual([
            ['git', 'ls-files', ROOT],
            ['git', 'grep', ROOT],
        ]);
    });
});
