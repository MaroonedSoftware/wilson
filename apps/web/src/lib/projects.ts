import { API_BASE } from './sdk.js';

/** One registered project, as `GET /api/projects` returns it (`routes.setup.ts`'s `ProjectsRouter`). */
export interface RegisteredProject {
    name: string;
}

/**
 * Every project this daemon has registered, name only (card 0154's `ProjectSwitcher.tsx`).
 *
 * A plain `fetch` against `API_BASE`, not a `WilsonSdk` method: `wilson`'s generated clients are one
 * per `.ck` contract, and every call the UI makes going through one is the convention `sdk.ts`'s own
 * comment states — but `GET /api/projects` is hand-written for the same reason `FeedRouter` and
 * `PlanStreamRouter` are (`routes.setup.ts`'s own doc comments): it answers across every registered
 * project, not the one a generated, `ProjectContextRouter`-scoped handler is built for, so there is no
 * `.ck` contract it belongs to. `useCardFeed` (`feed.ts`) already sets this precedent for `/api/feed`,
 * a plain `EventSource` against this same `API_BASE`.
 */
export const listRegisteredProjects = async (): Promise<RegisteredProject[]> => {
    const response = await fetch(`${API_BASE}/api/projects`);
    if (!response.ok) {
        throw new Error(`GET /api/projects: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as RegisteredProject[];
};
