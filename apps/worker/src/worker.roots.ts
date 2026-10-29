import { posix } from 'node:path';
import type { WorkerProject } from '@wilson/worker-protocol';

/**
 * The worker's own check on the paths Wilson asks it to touch: every file primitive's path must be
 * inside one of its host's project roots (a clone, its worktree root or its run root), as the latest
 * `welcome` named them. A command's working folder must be too, or `/`, which is where the probe runs
 * its checks from.
 *
 * A guardrail, not a boundary, for the reason `command.allowlist.ts` gives in apps/api: it stops a
 * file primitive pointed at the wrong place, and says nothing about what a command run inside a root
 * goes on to touch. The boundary for that is the machine itself, which is why a worker runs on a
 * machine kept for it.
 */
export class ProjectRoots {
    private roots: string[] = [];

    /** Replace the roots with `projects`' own, as the latest `welcome` gave them. */
    update(projects: readonly WorkerProject[]): void {
        this.roots = projects.flatMap(p => [p.codeRoot, p.worktreeRoot, p.runRoot]).map(root => posix.normalize(root).replace(/\/+$/, '') || '/');
    }

    /** Why `path` is refused, or undefined when it is inside a root. */
    checkPath = (path: string): string | undefined => {
        if (!path.startsWith('/')) return 'not an absolute path';
        const normal = posix.normalize(path);
        if (this.roots.some(root => normal === root || normal.startsWith(`${root}/`))) return undefined;
        return this.roots.length === 0 ? 'this worker serves no project yet' : 'outside this host’s project roots';
    };

    /** Why a command's working folder is refused, or undefined when it may run there. */
    checkCwd = (cwd: string): string | undefined => (posix.normalize(cwd) === '/' ? undefined : this.checkPath(cwd));
}
