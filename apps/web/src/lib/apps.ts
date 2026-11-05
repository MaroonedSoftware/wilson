import type { AppGrant } from '@wilson/sdk';

/** The API's limit on an app's HTML (`apps.service.ts`), here so a large file is refused before it is sent. */
export const MAX_APP_HTML_BYTES = 512 * 1024;

/** Every grant an app can hold and what it lets the app read, in the order the install form lists them. */
export const APP_GRANTS: readonly { grant: AppGrant; label: string; detail: string }[] = [
    { grant: 'board.read', label: 'Board', detail: 'Cards and columns, including what each card says' },
    { grant: 'activity.read', label: 'Activity', detail: 'What has happened on the project lately' },
    { grant: 'stats.read', label: 'Stats', detail: 'What the project has spent' },
];

export const grantLabel = (grant: AppGrant): string => APP_GRANTS.find(known => known.grant === grant)?.label ?? grant;

/** The slug a file suggests: `Burn Down.html` is `burn-down`. Empty when the name has nothing usable. */
export const slugFromFilename = (filename: string): string =>
    filename
        .replace(/\.html?$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63)
        .replace(/-+$/, '');

/** The name a file suggests: the file's own name without its extension. */
export const nameFromFilename = (filename: string): string => filename.replace(/\.html?$/i, '');

/** The grants `next` holds that `current` does not: what replacing an app would newly hand it. */
export const addedGrants = (current: readonly AppGrant[], next: readonly AppGrant[]): AppGrant[] => next.filter(grant => !current.includes(grant));
