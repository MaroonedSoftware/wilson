import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TOOL_ITEMS } from '#modules/agent/codex.stage.agent.js';

const exec = promisify(execFile);

/** The Codex protocol's vocabulary: what the server can notify, what it can ask, and what a thread can hold. */
export interface CodexKinds {
    notifications: string[];
    requests: string[];
    items: string[];
}

/** What a stage's adapter reads, out of `CodexKinds`. */
export type AdapterReads = CodexKinds;

export const BASELINE_PATH = new URL('./codex.protocol.kinds.json', import.meta.url);
const ADAPTER_PATH = new URL('../../src/modules/agent/codex.stage.agent.ts', import.meta.url);

/** Every distinct `"<field>": "<value>"` in generated source, sorted so a baseline diffs cleanly. */
const literals = (source: string, field: string): string[] =>
    [...new Set([...source.matchAll(new RegExp(`"${field}": "([^"]+)"`, 'g'))].map(match => match[1]!))].sort();

/** The kinds in the three files `codex app-server generate-ts` writes them to. */
export const parseKinds = (generated: { notifications: string; requests: string; items: string }): CodexKinds => ({
    notifications: literals(generated.notifications, 'method'),
    requests: literals(generated.requests, 'method'),
    items: literals(generated.items, 'type'),
});

/** What a binary says its protocol is, with `--experimental` because the adapter relies on that part. */
export const generateKinds = async (binary: string, outDir: string, env: NodeJS.ProcessEnv): Promise<CodexKinds> => {
    await exec(binary, ['app-server', 'generate-ts', '--experimental', '--out', outDir], { env });
    const [notifications, requests, items] = await Promise.all(
        ['ServerNotification.ts', 'ServerRequest.ts', 'v2/ThreadItem.ts'].map(file => readFile(join(outDir, file), 'utf8')),
    );
    return parseKinds({ notifications: notifications!, requests: requests!, items: items! });
};

export const readBaseline = async (): Promise<CodexKinds & { version: string }> =>
    JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as CodexKinds & { version: string };

export const writeBaseline = (version: string, kinds: CodexKinds): Promise<void> =>
    writeFile(BASELINE_PATH, `${JSON.stringify({ version, ...kinds }, undefined, 4)}\n`);

/**
 * What the adapter's own source compares against, read from the source so the list cannot drift from
 * it. `TOOL_ITEMS` counts as well as the direct comparisons: it is how the guard recognises a tool.
 */
export const parseAdapterReads = (source: string): AdapterReads => {
    const matched = (pattern: RegExp): string[] => [...source.matchAll(pattern)].map(match => match[1]!);
    const methods = new Set(matched(/\bmethod === '([^']+)'/g));
    const requests = matched(/\bmethod === '([^']+)'\) return await/g);
    return {
        notifications: [...methods].filter(method => !requests.includes(method)).sort(),
        requests: [...new Set(requests)].sort(),
        items: [...new Set([...matched(/\bitem\.type === '([^']+)'/g), ...TOOL_ITEMS])].sort(),
    };
};

export const readAdapterReads = async (): Promise<AdapterReads> => parseAdapterReads(await readFile(ADAPTER_PATH, 'utf8'));

export interface CodexDrift {
    /** The adapter would misbehave: fails the check. */
    failures: string[];
    /** Worth a look when bumping, and harmless to a running stage. */
    notes: string[];
}

const added = (from: string[], to: string[]): string[] => to.filter(kind => !from.includes(kind));

/**
 * Judges a binary's protocol against the baseline the adapter was written for.
 *
 * A new item type fails because `itemStarted` returns early on anything outside `TOOL_ITEMS`: a new
 * way of running a tool would pass through unguarded, with nothing to say so. A new request fails
 * because the adapter refuses what it does not know, which is safe but stops the stage. A kind the
 * adapter reads going away fails because whatever it fed goes quiet. A new notification is only noted:
 * the adapter ignores those, and Codex adds them often enough that failing would teach us to ignore
 * this check.
 */
export const judgeDrift = (baseline: CodexKinds, current: CodexKinds, reads: AdapterReads): CodexDrift => {
    const failures: string[] = [];
    const notes: string[] = [];
    const list = (kinds: string[]) => kinds.join(', ');

    const newItems = added(baseline.items, current.items);
    if (newItems.length > 0) failures.push(`new item types, which itemStarted would not guard: ${list(newItems)}`);
    const newRequests = added(baseline.requests, current.requests);
    if (newRequests.length > 0) failures.push(`new server requests, which the adapter would refuse: ${list(newRequests)}`);
    const newNotifications = added(baseline.notifications, current.notifications);
    if (newNotifications.length > 0) notes.push(`new notifications, ignored by the adapter: ${list(newNotifications)}`);

    for (const field of ['notifications', 'requests', 'items'] as const) {
        const gone = added(current[field], baseline[field]);
        const read = gone.filter(kind => reads[field].includes(kind));
        const unread = gone.filter(kind => !reads[field].includes(kind));
        if (read.length > 0) failures.push(`${field} the adapter reads are gone: ${list(read)}`);
        if (unread.length > 0) notes.push(`${field} the adapter does not read are gone: ${list(unread)}`);
    }
    return { failures, notes };
};
