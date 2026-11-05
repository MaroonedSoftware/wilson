import { DateTime } from 'luxon';
const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * What an app may ask the web app for. All of it is read-only, and all of it is about the project the
 * app was opened in.
 * generated from [AppGrant](../../../../apps/api/data/contracts/apps.ck)
 */
export type AppGrant = 'board.read' | 'activity.read' | 'stats.read';

/**
 * An app as a list shows it, without its HTML.
 * generated from [AppSummary](../../../../apps/api/data/contracts/apps.ck)
 */
export interface AppSummary {
    slug: string;
    name: string;
    description: string;
    grants: AppGrant[];
    createdAt: DateTime;
    updatedAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a AppSummary into its runtime type. Mutates and returns `raw`. */
export function reviveAppSummary(raw: AppSummary): AppSummary {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'AppSummary.createdAt');
    __o0['updatedAt'] = __dt(__o0['updatedAt'], 'AppSummary.updatedAt');
    return raw;
}

/**
 * An app and what it runs.
 * generated from [App](../../../../apps/api/data/contracts/apps.ck)
 */
export interface App {
    slug: string;
    name: string;
    description: string;
    grants: AppGrant[];
    html: string;
    createdAt: DateTime;
    updatedAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a App into its runtime type. Mutates and returns `raw`. */
export function reviveApp(raw: App): App {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'App.createdAt');
    __o0['updatedAt'] = __dt(__o0['updatedAt'], 'App.updatedAt');
    return raw;
}

/**
 * generated from [InstallAppRequest](../../../../apps/api/data/contracts/apps.ck)
 */
export interface InstallAppRequest {
    name: string;
    /** Unset means no description. */
    description?: string;
    /** The whole app, at most 512 KiB once encoded as UTF-8. */
    html: string;
    /** Replaces whatever grants the app had before. */
    grants: AppGrant[];
}
