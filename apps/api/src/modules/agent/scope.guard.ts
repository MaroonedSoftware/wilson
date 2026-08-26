import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';

export type ScopeDecision =
    | { allowed: true; path: string; via?: 'scope' | 'collateral' | 'grant' }
    | { allowed: false; path: string; reason: string };

export interface ScopeGuardOptions {
    /** Absolute path to the worktree. Nothing outside this is ever writable. */
    worktreeRoot: string;
    /** Globs from the card's `Files in scope`. */
    allow: string[];
    /** Machine-owned paths no plan should have to mention, e.g. `pnpm-lock.yaml`. */
    alwaysAllowed: string[];
    /** Extra deny globs from project config. The built-in denies below are always applied. */
    deny?: string[];
    /**
     * Worktree-relative paths a scoped file structurally depends on, derived by {@link collateralPaths}.
     * Allowed for a write without a `request_scope` round trip, but always reported — see `check`.
     */
    collateral?: string[];
    /**
     * Absolute paths of individual files the agent may read despite living outside the worktree.
     *
     * Exactly one thing needs this: the plan. It is materialized outside the tree on purpose, so it
     * can never be committed to the card's branch — which also put it beyond every tool, leaving the
     * agent to infer its own contract. Exact file paths only, never directories, and read-only.
     */
    readableExtras?: string[];
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
 * Refusal for a path on {@link ALWAYS_DENIED}. Says `request_scope` will not help, not just that
 * the path is off-limits — `grant` refuses these too (see its own test), so the message would
 * otherwise send an agent through a round trip that was always going to fail the same way.
 */
const DENY_LIST_REASON = 'path is denied: the runner owns it, not the plan — request_scope cannot widen it, so work through a different path';

/**
 * Worktree-relative path `report_result` writes a stage's finished result to (see
 * `cli.stage.agent.ts`) — the allow-side mirror of {@link ALWAYS_DENIED} above: a fixed, code-owned
 * name, not a project's `alwaysAllowed` entry in `stages.yaml`, because this is the runner's own
 * channel, not something a plan asked for or a project should have to declare. `check` allows a
 * write to exactly this path unconditionally; `grant` refuses to let `request_scope` claim it, since
 * a round trip through that tool can only ever land on the same unconditional allow.
 */
export const REPORT_RESULT_PATH = '.wilson-report.json';

/** Refusal for a `request_scope` call naming {@link REPORT_RESULT_PATH}. */
const REPORT_RESULT_GRANT_REASON =
    'path is the runner’s own report channel, not the plan’s to request — it is already writable without a grant';

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
    private readonly readableExtras: Set<string>;
    private readonly collateral: Set<string>;
    private readonly collateralUsed = new Set<string>();

    constructor(private readonly options: ScopeGuardOptions) {
        this.readableExtras = new Set((options.readableExtras ?? []).map(path => resolve(path)));
        const allow = [...options.allow, ...options.alwaysAllowed];
        // An empty allow list denies everything rather than allowing everything. A plan with no
        // `Files in scope` has not said what it may touch, and the safe reading of silence is "no".
        this.matchAllow = allow.length > 0 ? picomatch(allow, { dot: true }) : () => false;
        this.matchDeny = picomatch([...ALWAYS_DENIED, ...(options.deny ?? [])], { dot: true });
        this.collateral = new Set(options.collateral ?? []);
    }

    /**
     * Record a scope widening granted for this run.
     *
     * Refuses a path that could never take effect. A grant on something outside the worktree reads
     * to the operator as a widening that happened, when containment would still refuse every write —
     * a misleading entry in the log is worse than an honest refusal.
     */
    async grant(candidate: string): Promise<ScopeDecision> {
        const contained = await this.contain(candidate);
        if (!contained.allowed) return contained;
        if (contained.path === REPORT_RESULT_PATH) {
            return { allowed: false, path: contained.path, reason: REPORT_RESULT_GRANT_REASON };
        }
        if (this.matchDeny(contained.path)) {
            return { allowed: false, path: contained.path, reason: DENY_LIST_REASON };
        }
        this.granted.add(contained.path);
        return contained;
    }

    /** Every widening granted so far, for the exit condition and the event log. */
    grants(): string[] {
        return [...this.granted].sort();
    }

    /** Every collateral path a write was actually allowed against, for the event log and caveats. */
    collateralHits(): string[] {
        return [...this.collateralUsed].sort();
    }

    /**
     * Whether the agent may *read* a path.
     *
     * Containment and the deny list only — not the allow globs. An agent has to read the codebase to
     * change any part of it, and a plan that had to enumerate every file it might consult would be a
     * plan nobody could write. Scope constrains what changes, not what is understood.
     */
    async checkRead(candidate: string): Promise<ScopeDecision> {
        // Checked before containment, since the whole point of an extra is that it is outside.
        const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(this.options.worktreeRoot, candidate);
        if (this.readableExtras.has(absolute)) {
            return { allowed: true, path: absolute };
        }

        const contained = await this.contain(candidate);
        if (!contained.allowed) return contained;
        if (this.matchDeny(contained.path)) {
            return { allowed: false, path: contained.path, reason: DENY_LIST_REASON };
        }
        return contained;
    }

    async check(candidate: string): Promise<ScopeDecision> {
        const contained = await this.contain(candidate);
        if (!contained.allowed) return contained;
        const key = contained.path;

        // The runner's own channel, allowed unconditionally — see REPORT_RESULT_PATH's own comment.
        // Checked ahead of the deny list on purpose: it is not on ALWAYS_DENIED and never should be,
        // but this keeps the two lists' precedence obviously non-overlapping rather than incidental.
        if (key === REPORT_RESULT_PATH) {
            return { allowed: true, path: key, via: 'scope' };
        }

        if (this.matchDeny(key)) {
            return { allowed: false, path: key, reason: DENY_LIST_REASON };
        }
        if (this.granted.has(key)) {
            return { allowed: true, path: key, via: 'grant' };
        }
        if (this.matchAllow(key)) {
            return { allowed: true, path: key, via: 'scope' };
        }
        // Not itself in scope, but a file something in scope structurally depends on. Allowed
        // without a `request_scope` round trip — the caller still has to record it, since this is a
        // widening even though it needed no explicit ask.
        if (this.collateral.has(key)) {
            this.collateralUsed.add(key);
            return { allowed: true, path: key, via: 'collateral' };
        }
        // Naming the fix, not just the fault, same as the out-of-tree refusal below: a plan's scope
        // is closed by default, so "not listed" is a dead end an agent can only escape by asking for
        // a widening — say so here rather than leaving it to whichever caller happens to append it.
        return {
            allowed: false,
            path: key,
            reason: 'path is outside the plan’s files in scope — call request_scope with this path if the work genuinely needs it',
        };
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
            // The root is named here, not just in the prompt, because this refusal is where an agent
            // that guessed a wrong absolute prefix finds out — and a refusal it cannot act on is a
            // step it spends twice. 53 denials on this board carried the bare message; card 0104's
            // implementing stage read `/Users/robert/.worktrees/0104/...` when the tree was at
            // `/Users/robert/projects/.worktrees/0104/...`, was refused twice with nothing to
            // correct against, and ended having changed nothing. Relative is the form every scoped
            // path in a plan already takes, and what `contain` resolves against, so it is the remedy
            // worth naming rather than a corrected absolute path.
            return {
                allowed: false,
                path: candidate,
                reason:
                    `path resolves outside the worktree. This worktree's root is ${root} — ` +
                    `give a path relative to it (for example "apps/api/src/index.ts"), not an absolute path`,
            };
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
