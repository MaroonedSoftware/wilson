import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { AppGrant, type App, type AppSummary, type InstallAppRequest } from '../../generated/apps.js';
import { AppsRepository, type AppRow, type AppValues } from './apps.repository.js';

/**
 * The most HTML an app may hold, in UTF-8 bytes. Half the body parser's 1 MB limit for JSON, so that
 * the escaping JSON adds to ordinary HTML cannot push an app under this limit over that one.
 */
export const MAX_APP_HTML_BYTES = 512 * 1024;

/** What an app's slug must match. */
export const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A stored grant this build no longer knows is dropped, not an error. An app then loses that access
 * instead of being unable to load, and nothing later can act on a grant the contract does not list.
 */
const knownGrants = (grants: string[]): AppGrant[] => grants.flatMap(grant => AppGrant.safeParse(grant).data ?? []);

const toSummary = (row: Omit<AppRow, 'html'>): AppSummary => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    grants: knownGrants(row.grants),
    ...(row.version === null ? {} : { version: row.version }),
    apiVersion: row.apiVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const toApp = (row: AppRow): App => ({ ...toSummary(row), html: row.html });

/** What an install writes, once its slug, name, size and API version pass. */
const validated = (slug: string, request: InstallAppRequest): AppValues => {
    if (!APP_SLUG.test(slug)) {
        throw httpError(400).withDetails({ reason: 'a slug is 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit' });
    }
    const name = request.name.trim();
    if (name.length === 0) throw httpError(400).withDetails({ reason: 'name must not be blank' });
    const bytes = Buffer.byteLength(request.html, 'utf8');
    if (bytes > MAX_APP_HTML_BYTES) {
        throw httpError(400).withDetails({ reason: `html must be at most ${MAX_APP_HTML_BYTES} bytes, got ${bytes}` });
    }
    const apiVersion = request.apiVersion ?? 1;
    if (apiVersion < 1) throw httpError(400).withDetails({ reason: 'apiVersion must be 1 or more' });
    const version = request.version?.trim();
    return {
        slug,
        name,
        description: request.description?.trim() ?? '',
        html: request.html,
        grants: [...new Set(request.grants)],
        version: version ? version : null,
        apiVersion,
    };
};

/**
 * The installed operator apps (`apps.ck`). This stores them and says what they were granted. Running
 * one and enforcing its grants is the web app's job, since an app holds no credential and reaches the
 * API only through the page that opened it.
 */
@Injectable()
export class AppsService {
    constructor(private readonly apps: AppsRepository) {}

    async list(): Promise<AppSummary[]> {
        return (await this.apps.list()).map(toSummary);
    }

    async get(slug: string): Promise<App> {
        const row = await this.apps.find(slug);
        if (!row) throw httpError(404).withDetails({ reason: `no app "${slug}"` });
        return toApp(row);
    }

    async install(slug: string, request: InstallAppRequest): Promise<App> {
        return toApp(await this.apps.upsert(validated(slug, request)));
    }

    /**
     * Install an app under a slug nothing holds. A proposal from the chat comes through here, not
     * {@link install}: replacing an app would run new code under grants the person already gave.
     */
    async create(slug: string, request: InstallAppRequest): Promise<App> {
        const row = await this.apps.insert(validated(slug, request));
        if (!row) throw httpError(409).withDetails({ reason: `an app named "${slug}" is already installed` });
        return toApp(row);
    }

    /** Whether an app is installed under this slug. */
    async exists(slug: string): Promise<boolean> {
        return (await this.apps.find(slug)) !== undefined;
    }

    async remove(slug: string): Promise<void> {
        if (!(await this.apps.delete(slug))) throw httpError(404).withDetails({ reason: `no app "${slug}"` });
    }
}
