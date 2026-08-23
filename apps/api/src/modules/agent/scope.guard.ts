import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';

export type ScopeDecision = { allowed: true; path: string } | { allowed: false; path: string; reason: string };

export interface ScopeGuardOptions {
    /** Absolute path to the worktree. Nothing outside this is ever writable. */
    worktreeRoot: string;
    /** Globs from the card's `Files in scope`. */
    allow: string[];
    /** Machine-owned paths no plan should have to mention, e.g. `pnpm-lock.yaml`. */
    alwaysAllowed: string[];
    /** Extra deny globs from project config. The built-in denies below are always applied. */
    deny?: string[];
}

/**
 * Paths an agent may never write, whatever the plan says (PROJECT.md decisions 6 and 9).
 *
 * `.runner/` and stage config are the machinery: an agent that can rewrite its own exit condition
 * passes every time. Board paths are here as a backstop — the board lives in a sibling repo, so a
 * worktree should contain none of these, and if one appears something has gone wrong upstream.
 */
const ALWAYS_DENIED = ['.runner/**', '.board/**', '**/stages.yaml', '**/stages.yml', '.git/**'];

/**
 * Decides whether an agent may write a path.
 *
 * This is the single enforcement point for scope. It is not a lint that runs after the fact: a write
 * outside scope fails at the tool, so the diff can never contain one in the first place.
 *
 * The check resolves symlinks before matching. A glob test against an unresolved path is
 * bypassable — `src/link/../../../etc/passwd`, or a symlink the agent itself created inside an
 * allowed directory — and the containment test is the part that actually keeps writes in the tree.
 */
export class ScopeGuard {
    private readonly matchAllow: (path: string) => boolean;
    private readonly matchDeny: (path: string) => boolean;
    private readonly granted = new Set<string>();

    constructor(private readonly options: ScopeGuardOptions) {
        const allow = [...options.allow, ...options.alwaysAllowed];
        // An empty allow list denies everything rather than allowing everything. A plan with no
        // `Files in scope` has not said what it may touch, and the safe reading of silence is "no".
        this.matchAllow = allow.length > 0 ? picomatch(allow, { dot: true }) : () => false;
        this.matchDeny = picomatch([...ALWAYS_DENIED, ...(options.deny ?? [])], { dot: true });
    }

    /** Record a scope widening granted for this run. Subsequent writes to the path are allowed. */
    grant(relativePath: string): void {
        this.granted.add(relativePath);
    }

    /** Every widening granted so far, for the exit condition and the event log. */
    grants(): string[] {
        return [...this.granted].sort();
    }

    /**
     * Whether the agent may *read* a path.
     *
     * Containment and the deny list only — not the allow globs. An agent has to read the codebase to
     * change any part of it, and a plan that had to enumerate every file it might consult would be a
     * plan nobody could write. Scope constrains what changes, not what is understood.
     */
    async checkRead(candidate: string): Promise<ScopeDecision> {
        const contained = await this.contain(candidate);
        if (!contained.allowed) return contained;
        if (this.matchDeny(contained.path)) {
            return { allowed: false, path: contained.path, reason: 'path is denied: the runner owns it, not the plan' };
        }
        return contained;
    }

    async check(candidate: string): Promise<ScopeDecision> {
        const contained = await this.contain(candidate);
        if (!contained.allowed) return contained;
        const key = contained.path;

        if (this.matchDeny(key)) {
            return { allowed: false, path: key, reason: 'path is denied: the runner owns it, not the plan' };
        }
        if (this.granted.has(key)) {
            return { allowed: true, path: key };
        }
        if (!this.matchAllow(key)) {
            return { allowed: false, path: key, reason: 'path is outside the plan’s files in scope' };
        }
        return { allowed: true, path: key };
    }

    /**
     * Resolve a candidate to a worktree-relative key, or refuse it for escaping the tree.
     *
     * Shared by both checks because containment is the part that is genuinely load-bearing: the
     * glob lists decide policy, but this decides whether the path is even in the sandbox.
     */
    private async contain(candidate: string): Promise<ScopeDecision> {
        const absolute = isAbsolute(candidate) ? candidate : resolve(this.options.worktreeRoot, candidate);

        // Resolve the nearest existing ancestor: the file itself may not exist yet (a create), but
        // its parent chain does, and that is what a traversal or symlink escape would go through.
        const resolved = await this.resolveThroughExisting(absolute);
        const root = await realpath(this.options.worktreeRoot).catch(() => this.options.worktreeRoot);

        const rel = relative(root, resolved);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
            return { allowed: false, path: candidate, reason: 'path resolves outside the worktree' };
        }

        // Normalise to forward slashes so the globs in a plan are platform-independent.
        return { allowed: true, path: rel.split(sep).join('/') };
    }

    /**
     * `realpath` the deepest part of the path that exists, then re-append the rest.
     *
     * `realpath` throws on a path that does not exist yet, but a create still has to be checked —
     * and the symlink that matters is somewhere in the existing ancestry, not in the leaf being
     * created.
     */
    private async resolveThroughExisting(absolute: string): Promise<string> {
        const missing: string[] = [];
        let cursor = absolute;

        for (;;) {
            try {
                const real = await realpath(cursor);
                return missing.length > 0 ? resolve(real, ...missing.reverse()) : real;
            } catch {
                const parent = dirname(cursor);
                // Reached the filesystem root without finding anything that exists.
                if (parent === cursor) return absolute;
                missing.push(cursor.slice(parent.length + 1));
                cursor = parent;
            }
        }
    }
}
