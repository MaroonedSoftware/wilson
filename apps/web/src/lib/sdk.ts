import { WilsonSdk } from '@wilson/sdk';
import { resolveApiBase } from './api.config.js';

export const API_BASE = resolveApiBase(import.meta.env.VITE_API_URL as string | undefined);

/**
 * The generated client, one instance for the app.
 *
 * Every call the UI makes goes through this — hand-written `fetch` against the API is the drift
 * the contract exists to prevent (PROJECT.md, Architecture).
 */
export const wilson = new WilsonSdk({ baseUrl: API_BASE });

/**
 * Card 0153. A client scoped to one project, sent as `X-Wilson-Project` on every call
 * (`SdkOptions.project`, card 0150). `project` is fixed at construction, so a project change means
 * building a new client here, never mutating `wilson` above or one returned by an earlier call — a
 * half-switched client would send one project's header while a component reads another's cache.
 *
 * The `/projects/$project/*` routes call this with their own route's `project` param; the existing
 * top-level routes keep using `wilson` above, exactly as they do today.
 */
export const wilsonForProject = (project: string): WilsonSdk => new WilsonSdk({ baseUrl: API_BASE, project });
