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

/**
 * What an app's document may load: its own inline script and style, and `data:` images, fonts and
 * media. Everything `default-src` falls back to is refused, which is what stops `fetch`, WebSockets
 * and outside scripts. Workers and frames are named as well because they would otherwise fall back
 * through `script-src` and `child-src` rather than to `default-src` alone.
 *
 * This does not seal an app in. `webrtc` is the one way out no fetch directive covers, and Chromium
 * ignores it: measured 2026-11-05 in Chromium and Brave, an app with this policy still sent STUN
 * packets to a server it named. So an app could get out what it can read, and the boundary is what it
 * can read, not where it can send.
 */
export const APP_CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    'media-src data:',
    "worker-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "webrtc 'block'",
].join('; ');

/** The iframe's `sandbox` value. Scripts only: no same-origin, popups, forms or top navigation. */
export const APP_SANDBOX = 'allow-scripts';

/**
 * The document an app runs as: the policy, then the app's HTML exactly as installed. The policy comes
 * first so it is in force before the app's first byte is parsed. Anything the app writes can add to
 * it but never loosen it, and its own `<!doctype>`, `<html>` and `<head>` tags merge into this one.
 */
export const appDocument = (html: string): string =>
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${APP_CONTENT_SECURITY_POLICY}">${html}`;
