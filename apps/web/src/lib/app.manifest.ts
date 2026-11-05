import type { AppGrant } from '@wilson/sdk';
import { APP_GRANTS } from './apps.js';

/** The `type` of the script element an app's manifest is written in. A browser runs no script of this type. */
export const APP_MANIFEST_TYPE = 'application/wilson-app+json';

/** The same rule the API holds a slug to (`apps.service.ts`). */
const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The most grants a manifest may ask for. Far more than there are, so only a broken file meets it. */
const MAX_GRANT_REQUESTS = 20;

/**
 * One grant an app asks for, with its reason, which is the author's words for the operator. `known` is
 * false for a grant this Wilson does not have: it is shown, so the operator knows the app wanted it, and
 * cannot be given.
 */
export interface AppGrantRequest {
    grant: string;
    reason: string;
    known: boolean;
}

/**
 * What an app says about itself. It is a request and nothing more: the operator still decides each grant,
 * and the file cannot give itself one.
 */
export interface AppManifest {
    id: string;
    name: string;
    description?: string;
    version: string;
    apiVersion: number;
    grants: AppGrantRequest[];
}

export type AppManifestReading = { ok: true; manifest: AppManifest } | { ok: false; reason: string };

const refuse = (reason: string): AppManifestReading => ({ ok: false, reason });

const isKnownGrant = (grant: string): grant is AppGrant => APP_GRANTS.some(known => known.grant === grant);

/** A trimmed string of the given length, or undefined. */
const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
};

/**
 * Reads the manifest out of an app's HTML, without running any of it: `DOMParser` builds a document whose
 * scripts never run, and the manifest is JSON in a script of a type nothing executes.
 *
 * Keys it does not know are ignored, so a manifest written for a later Wilson still installs here.
 */
export const readAppManifest = (html: string): AppManifestReading => {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const elements = [...document.querySelectorAll('script')].filter(element => element.type.trim().toLowerCase() === APP_MANIFEST_TYPE);
    if (elements.length === 0) return refuse(`The file has no manifest: a <script type="${APP_MANIFEST_TYPE}"> saying what the app is.`);
    if (elements.length > 1) return refuse('The file has more than one manifest.');

    let value: unknown;
    try {
        value = JSON.parse(elements[0]!.textContent ?? '');
    } catch {
        return refuse('The manifest is not valid JSON.');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse('The manifest is not a JSON object.');
    const fields = value as Record<string, unknown>;

    const id = typeof fields.id === 'string' && APP_ID.test(fields.id) ? fields.id : undefined;
    if (!id) return refuse('The manifest\'s "id" must be 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit.');
    const name = text(fields.name, 100);
    if (!name) return refuse('The manifest\'s "name" must be 1 to 100 characters.');
    const version = text(fields.version, 50);
    if (!version) return refuse('The manifest\'s "version" must be 1 to 50 characters.');
    const apiVersion = fields.apiVersion;
    if (typeof apiVersion !== 'number' || !Number.isSafeInteger(apiVersion) || apiVersion < 1) {
        return refuse('The manifest\'s "apiVersion" must be a whole number, 1 or more.');
    }
    const description = fields.description === undefined ? undefined : text(fields.description, 500);
    if (fields.description !== undefined && fields.description !== '' && description === undefined) {
        return refuse('The manifest\'s "description" must be at most 500 characters.');
    }

    const asked = fields.grants ?? [];
    if (!Array.isArray(asked) || asked.length > MAX_GRANT_REQUESTS)
        return refuse(`The manifest's "grants" must be a list of at most ${MAX_GRANT_REQUESTS}.`);
    const grants: AppGrantRequest[] = [];
    for (const request of asked) {
        const { grant, reason } = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>;
        const grantName = text(grant, 100);
        const why = text(reason, 300);
        if (!grantName || !why) return refuse('Each grant in the manifest needs a "grant" and a "reason" of at most 300 characters saying why.');
        if (grants.some(seen => seen.grant === grantName)) return refuse(`The manifest asks for ${grantName} twice.`);
        grants.push({ grant: grantName, reason: why, known: isKnownGrant(grantName) });
    }

    return { ok: true, manifest: { id, name, ...(description ? { description } : {}), version, apiVersion, grants } };
};

/** The grants a manifest asks for that this Wilson can give. */
export const grantableRequests = (manifest: AppManifest): AppGrant[] =>
    manifest.grants.flatMap(request => (isKnownGrant(request.grant) ? [request.grant] : []));
