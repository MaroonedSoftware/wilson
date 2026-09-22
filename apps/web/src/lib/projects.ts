import type { Project } from '@wilson/sdk';
import { wilson } from './sdk.js';

/** One registered project, as `GET /api/projects` returns it (`projects.ck`'s `Project`). */
export type RegisteredProject = Project;

/**
 * Every project this daemon has registered, name only (card 0154's `ProjectSwitcher.tsx`).
 *
 * Card 0162 gave `GET /api/projects` a `.ck` contract (`apps/api/data/contracts/projects.ck`) and a
 * generated client, `ProjectsClient` (`@wilson/sdk`'s `projects.client.ts`) — reached here through the
 * unscoped `wilson` singleton (`sdk.ts`), not `useWilsonSdk()`'s route-scoped client: the endpoint
 * answers across every registered project, the same reason its own contract needs no project header
 * or `?project=` and refuses none.
 */
export const listRegisteredProjects = async (): Promise<RegisteredProject[]> => wilson.projects.listProjects();

/** The two paths `POST /api/projects` needs beyond `codeRoot`, as the new-project form proposes them. */
export interface ProjectPathDefaults {
    worktreeRoot: string;
    runRoot: string;
}

/**
 * Proposes a worktree root and run root for a project whose repo lives at `codeRoot`:
 * `<parent>/.worktrees/<name>` and `<parent>/.run/<name>`, where `<parent>` is the directory holding
 * the repo. That matches where `BoardModule` puts the daemon's own project (`<codeRoot>/../.worktrees`,
 * `<codeRoot>/../.run`) and adds a per-project segment, so two repos under one parent never share a
 * worktree or run directory (card ids restart at 0001 on every board).
 *
 * Proposes nothing (empty strings) until there is both a name and an absolute `codeRoot`: a relative
 * path would only be refused by the API, and a half-derived path is worse than an empty field.
 */
export function defaultProjectPaths(name: string, codeRoot: string): ProjectPathDefaults {
    const trimmedName = name.trim();
    const root = codeRoot.trim().replace(/\/+$/, '');
    if (!trimmedName || !root.startsWith('/')) return { worktreeRoot: '', runRoot: '' };

    const parent = root.slice(0, root.lastIndexOf('/'));
    return { worktreeRoot: `${parent}/.worktrees/${trimmedName}`, runRoot: `${parent}/.run/${trimmedName}` };
}
