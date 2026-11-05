// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_MANIFEST_TYPE, grantableRequests, readAppManifest, type AppManifestReading } from '#src/lib/app.manifest.js';

/** Reading what an app says about itself, which is a request the operator answers and never a grant. */

const MANIFEST = {
    id: 'burndown',
    name: 'Burndown',
    version: '1.2.0',
    apiVersion: 1,
    description: 'Cards left',
    grants: [{ grant: 'board.read', reason: 'Counts cards.' }],
};

const page = (manifest: unknown, type = APP_MANIFEST_TYPE) =>
    `<!doctype html><title>x</title><script type="${type}">${typeof manifest === 'string' ? manifest : JSON.stringify(manifest)}</script><h1>hi</h1>`;

const reason = (reading: AppManifestReading) => (reading.ok ? undefined : reading.reason);

describe('readAppManifest', () => {
    it('reads the manifest', () => {
        expect(readAppManifest(page(MANIFEST))).toEqual({
            ok: true,
            manifest: { ...MANIFEST, grants: [{ grant: 'board.read', reason: 'Counts cards.', known: true }] },
        });
    });

    it('trims, leaves out an empty description and ignores keys it does not know', () => {
        const reading = readAppManifest(page({ ...MANIFEST, name: ' Burndown ', description: '', later: true }));

        expect(reading.ok && reading.manifest).toEqual({
            id: 'burndown',
            name: 'Burndown',
            version: '1.2.0',
            apiVersion: 1,
            grants: [{ grant: 'board.read', reason: 'Counts cards.', known: true }],
        });
    });

    it('keeps a grant this Wilson does not have, marked so it cannot be given', () => {
        const reading = readAppManifest(page({ ...MANIFEST, grants: [...MANIFEST.grants, { grant: 'board.write', reason: 'Moves cards.' }] }));

        expect(reading.ok && reading.manifest.grants[1]).toEqual({ grant: 'board.write', reason: 'Moves cards.', known: false });
        expect(reading.ok && grantableRequests(reading.manifest)).toEqual(['board.read']);
    });

    it('accepts an app that asks for nothing', () => {
        expect(readAppManifest(page({ ...MANIFEST, grants: undefined }))).toMatchObject({ ok: true, manifest: { grants: [] } });
    });

    it('does not run the page to read it', () => {
        (window as unknown as { ran?: boolean }).ran = false;

        readAppManifest(`<script>window.ran = true</script>${page(MANIFEST)}<img src="x" onerror="window.ran = true">`);

        expect((window as unknown as { ran?: boolean }).ran).toBe(false);
    });

    it.each([
        ['no manifest', '<h1>hi</h1>', 'has no manifest'],
        ['a manifest of another type', page(MANIFEST, 'application/json'), 'has no manifest'],
        ['two manifests', page(MANIFEST) + page(MANIFEST), 'more than one'],
        ['broken JSON', page('{ "id": '), 'not valid JSON'],
        ['a list', page([]), 'not a JSON object'],
        ['a bad id', page({ ...MANIFEST, id: 'Burn Down' }), '"id"'],
        ['no name', page({ ...MANIFEST, name: '  ' }), '"name"'],
        ['no version', page({ ...MANIFEST, version: undefined }), '"version"'],
        ['an API version of 0', page({ ...MANIFEST, apiVersion: 0 }), '"apiVersion"'],
        ['a fractional API version', page({ ...MANIFEST, apiVersion: 1.5 }), '"apiVersion"'],
        ['a long description', page({ ...MANIFEST, description: 'x'.repeat(501) }), '"description"'],
        ['grants that are not a list', page({ ...MANIFEST, grants: 'board.read' }), '"grants"'],
        ['a grant with no reason', page({ ...MANIFEST, grants: [{ grant: 'board.read' }] }), 'reason'],
        ['a grant asked for twice', page({ ...MANIFEST, grants: [MANIFEST.grants[0], MANIFEST.grants[0]] }), 'twice'],
    ])('refuses %s', (_, html, expected) => {
        expect(reason(readAppManifest(html))).toContain(expected);
    });

    // By the working directory, which is the package's, as jsdom's `URL` will not resolve a file one.
    it('reads the example app', () => {
        const html = readFileSync(join(process.cwd(), 'examples/apps/board-summary.html'), 'utf8');

        expect(readAppManifest(html)).toMatchObject({ ok: true, manifest: { id: 'board-summary', apiVersion: 1 } });
    });
});
