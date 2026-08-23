import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from 'injectkit';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { WorktreeManager, type Worktree } from '#modules/worktree/worktree.manager.js';
import type { StageConfig } from './stage.config.js';

const exec = promisify(execFile);

export interface VerificationInput {
    worktree: Worktree;
    scope: ScopeGuard;
    stage: StageConfig;
}

/**
 * The implementing stage's exit condition, in order, all three required.
 *
 * Every exit condition an agent can satisfy by doing less work is one it will eventually satisfy by
 * doing less work (PROJECT.md). `build passes` on its own is satisfied by an empty diff, so the diff
 * must be non-empty; and a non-empty diff on its own says nothing about *where* it landed, so every
 * changed path is re-checked against scope.
 *
 * The scope re-check is not redundant with the write tool. The tool stops the writes it sees; this
 * catches anything that reached the tree another way — a file moved by an allowlisted command, or a
 * build step that wrote outside its lane.
 */
@Injectable()
export class ImplementingVerifier {
    constructor(private readonly worktrees: WorktreeManager) {}

    async verify({ worktree, scope, stage }: VerificationInput): Promise<{ passed: boolean; failures: string[]; changedPaths: string[] }> {
        const failures: string[] = [];
        const changedPaths = await this.worktrees.changedPaths(worktree);

        if (changedPaths.length === 0) {
            failures.push('the diff is empty: the stage changed nothing');
        }

        for (const path of changedPaths) {
            const decision = await scope.check(path);
            if (!decision.allowed) {
                failures.push(`${path} is outside the plan’s files in scope (${decision.reason})`);
            }
        }

        if (stage.buildCommand) {
            const build = await this.runBuild(worktree.path, stage.buildCommand);
            if (build) failures.push(build);
        }

        return { passed: failures.length === 0, failures, changedPaths };
    }

    /** Returns a failure string, or undefined when the build passed. */
    private async runBuild(cwd: string, command: string): Promise<string | undefined> {
        const [file, ...args] = command.trim().split(/\s+/).filter(Boolean);
        if (!file) return 'stage has a buildCommand that is empty';

        try {
            await exec(file, args, { cwd, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
            return undefined;
        } catch (err) {
            const e = err as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
            if (e.killed) return `build command timed out: ${command}`;
            const output = [e.stdout?.trim(), e.stderr?.trim()].filter(Boolean).join('\n').slice(-4000);
            return `build command failed (exit ${e.code ?? 'unknown'}): ${command}\n${output}`;
        }
    }
}
