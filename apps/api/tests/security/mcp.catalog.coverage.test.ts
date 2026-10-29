import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The operation catalog the chat proposes actions from (`McpModule`) must hold nothing that hands
 * out or rewrites authority (PROJECT.md decision 10). A chat action runs once the operator approves
 * it with an ordinary `wilson.manage` session, or a `manage` key, so an operation gated
 * `wilson.step.up` reached through the catalog would get past the recently-proved-factor rule, and a
 * credential operation would put signing in within an agent's reach.
 *
 * Read from the generated files, so a contract that forgets `mcp: exclude` fails here the moment it
 * is regenerated.
 */
const ROOT = fileURLToPath(new URL('../../src/', import.meta.url));

/** Every `METHOD /path` a generated router serves, with the policy it asserts. */
const routes = async (): Promise<{ route: string; policy: string | undefined }[]> => {
    const dir = join(ROOT, 'routes');
    const found: { route: string; policy: string | undefined }[] = [];
    for (const file of (await readdir(dir)).filter(name => name.endsWith('.router.ts'))) {
        const text = await readFile(join(dir, file), 'utf8');
        for (const match of text.matchAll(/Router\.(get|post|put|patch|delete)\('([^']+)'(?:,\s*requirePolicy\(\{ policy: '([^']+)' \}\))?/g)) {
            found.push({ route: `${match[1]!.toUpperCase()} ${match[2]!.replace(/:([A-Za-z]+)/g, '{$1}')}`, policy: match[3] });
        }
    }
    return found;
};

/** Every `METHOD /path` the generated catalog has a handler for. */
const catalogued = async (): Promise<Set<string>> => {
    const dir = join(ROOT, 'modules', 'mcp', 'generated');
    const found = new Set<string>();
    for (const file of (await readdir(dir)).filter(name => name.endsWith('.mcp.ts'))) {
        const text = await readFile(join(dir, file), 'utf8');
        for (const match of text.matchAll(/\.ck\]\([^)]*\) `((?:GET|POST|PUT|PATCH|DELETE) [^`]+)`/g)) found.add(match[1]!);
    }
    return found;
};

describe('the operation catalog', () => {
    it('finds the routes and the catalog it is checking', async () => {
        expect((await routes()).length).toBeGreaterThan(40);
        expect((await catalogued()).size).toBeGreaterThan(20);
    });

    it('holds no operation gated wilson.step.up', async () => {
        const catalog = await catalogued();
        const stepUp = (await routes()).filter(({ policy }) => policy === 'wilson.step.up').map(({ route }) => route);

        expect(stepUp).toContain('PUT /api/stages/config');
        expect(stepUp.filter(route => catalog.has(route))).toEqual([]);
    });

    it('holds nothing that signs in, onboards, or manages credentials', async () => {
        const credential = [...(await catalogued())].filter(route => / \/api\/(auth|onboarding)(\/|$)/.test(route));

        expect(credential).toEqual([]);
    });
});
