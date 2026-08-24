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
