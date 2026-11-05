import type { AppGrant, ChatPendingAction } from '@wilson/sdk';
import { APP_METHOD_NAMES } from './app.broker.js';

/**
 * The versions of the app API (`app.api.ck`) this host offers. An app written for another is not opened,
 * since the answers it would get are not the ones it was written for. The desktop app keeps the same list
 * (`AppDocument.ApiVersions`), held to it by `app-host.json`.
 */
export const APP_API_VERSIONS: readonly number[] = [1];

/** Why an app cannot be opened here, or undefined when it can. */
export const unsupportedApiVersion = (apiVersion: number): string | undefined =>
    APP_API_VERSIONS.includes(apiVersion)
        ? undefined
        : `It was written for version ${apiVersion} of the app API, and this Wilson offers ${APP_API_VERSIONS.map(String).join(' and ')}. Updating Wilson may be all it needs.`;

/** The API's limit on an app's HTML (`apps.service.ts`), here so a large file is refused before it is sent. */
export const MAX_APP_HTML_BYTES = 512 * 1024;

/** Every grant an app can hold and what it lets the app read, in the order the install form lists them. */
export const APP_GRANTS: readonly { grant: AppGrant; label: string; detail: string }[] = [
    { grant: 'board.read', label: 'Board', detail: 'Cards and columns, including what each card says' },
    { grant: 'activity.read', label: 'Activity', detail: 'What has happened on the project lately' },
    { grant: 'stats.read', label: 'Stats', detail: 'What the project has spent' },
];

export const grantLabel = (grant: AppGrant): string => APP_GRANTS.find(known => known.grant === grant)?.label ?? grant;

/** The operation a proposed app's action is stored under (`chat.app.proposal.ts` in apps/api). */
export const PROPOSED_APP_OPERATION = 'install_proposed_app';

/** An operator app the chat proposed, as its review reads it. */
export interface ProposedApp {
    slug: string;
    name: string;
    description?: string;
    html: string;
    requestedGrants: AppGrant[];
}

/**
 * The app a chat action proposes, or undefined when it is any other action, or one whose arguments are
 * not what this build expects. That one falls to the ordinary card, whose confirm the API refuses,
 * since it sends no grants.
 */
export const proposedApp = (action: ChatPendingAction): ProposedApp | undefined => {
    if (action.operation !== PROPOSED_APP_OPERATION) return undefined;
    const args = action.arguments as Partial<Record<keyof ProposedApp, unknown>> | null;
    if (typeof args?.slug !== 'string' || typeof args.name !== 'string' || typeof args.html !== 'string') return undefined;
    const known = APP_GRANTS.map(({ grant }) => grant);
    return {
        slug: args.slug,
        name: args.name,
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
        html: args.html,
        requestedGrants: Array.isArray(args.requestedGrants) ? known.filter(grant => (args.requestedGrants as unknown[]).includes(grant)) : [],
    };
};

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

/** The colour scheme an app is told to draw in: always the one Wilson is showing, never `auto`. */
export type AppColorScheme = 'light' | 'dark';

/** What an app is told about where it is running. */
export interface AppContext {
    project: string;
    grants: readonly AppGrant[];
    colorScheme: AppColorScheme;
}

/** What the host tells an app unasked. A change carries no detail, so it holds nothing to grant. */
export type AppEvent = { event: 'change' } | { event: 'colorScheme'; colorScheme: AppColorScheme };

/** JSON that is safe inside a script element: no `<`, so nothing in it can end the element. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c');

/**
 * `window.wilson` as an app sees it: a promise-returning function per method, the project and grants,
 * and `onChange` and `onColorSchemeChange`, each returning a function that stops listening. Calls made
 * before the host connects wait for it. This is a convenience for the app and enforces nothing, since
 * the app's own code can replace it, and the host checks every request.
 *
 * It also sets the document's `color-scheme`, so an app with no styles of its own still matches.
 */
const appClient = ({ project, grants, colorScheme }: AppContext): string =>
    `(() => {
const names = ${scriptJson(APP_METHOD_NAMES)};
const waiting = new Map();
const early = [];
const changeListeners = new Set();
const schemeListeners = new Set();
let colorScheme = ${scriptJson(colorScheme)};
let port;
let next = 0;
const listen = listeners => listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
const applyScheme = () => {
    document.documentElement.style.colorScheme = colorScheme;
};
applyScheme();
addEventListener('message', event => {
    if (port || event.source !== parent || event.data !== ${scriptJson(APP_CONNECT_MESSAGE)} || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
        if (data.event === 'change') {
            for (const listener of [...changeListeners]) listener();
            return;
        }
        if (data.event === 'colorScheme') {
            if (data.colorScheme === colorScheme) return;
            colorScheme = data.colorScheme;
            applyScheme();
            for (const listener of [...schemeListeners]) listener(colorScheme);
            return;
        }
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
    get colorScheme() {
        return colorScheme;
    },
    onChange: listen(changeListeners),
    onColorSchemeChange: listen(schemeListeners),
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
