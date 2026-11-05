import type { AppGrant } from '@wilson/sdk';
import { APP_METHOD_NAMES } from './app.broker.js';

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

/** What the host says to an app's frame when it hands over the app's port. */
export const APP_CONNECT_MESSAGE = 'wilson.connect';

/** What an app is told about where it is running. */
export interface AppContext {
    project: string;
    grants: readonly AppGrant[];
}

/** JSON that is safe inside a script element: no `<`, so nothing in it can end the element. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c');

/**
 * `window.wilson` as an app sees it: a promise-returning function per method, plus the project and
 * grants. Calls made before the host connects wait for it. This is a convenience for the app and
 * enforces nothing, since the app's own code can replace it, and the host checks every request.
 */
const appClient = ({ project, grants }: AppContext): string =>
    `(() => {
const names = ${scriptJson(APP_METHOD_NAMES)};
const waiting = new Map();
const early = [];
let port;
let next = 0;
addEventListener('message', event => {
    if (port || event.source !== parent || event.data !== ${scriptJson(APP_CONNECT_MESSAGE)} || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
        const call = waiting.get(data.id);
        if (!call) return;
        waiting.delete(data.id);
        if (data.ok) call.resolve(data.result);
        else call.reject(new Error(data.error));
    };
    for (const request of early.splice(0)) port.postMessage(request);
});
const method = name => (...args) =>
    new Promise((resolve, reject) => {
        const id = ++next;
        waiting.set(id, { resolve, reject });
        if (port) port.postMessage({ id, method: name, args });
        else early.push({ id, method: name, args });
    });
window.wilson = Object.freeze({
    project: ${scriptJson(project)},
    grants: Object.freeze(${scriptJson(grants)}),
    ...Object.fromEntries(names.map(name => [name, method(name)])),
});
})();`;

/**
 * The document an app runs as: the policy, the client, then the app's HTML exactly as installed. The
 * policy comes first so it is in force before the app's first byte is parsed. Anything the app writes
 * can add to it but never loosen it, and its own `<!doctype>`, `<html>` and `<head>` tags merge into
 * this one.
 */
export const appDocument = (html: string, context: AppContext): string =>
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${APP_CONTENT_SECURITY_POLICY}"><script>${appClient(context)}</script>${html}`;
