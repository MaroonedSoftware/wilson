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
