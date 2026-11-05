import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_METHOD_NAMES } from '#src/lib/app.broker.js';
import { MAX_APP_HTML_BYTES } from '#src/lib/apps.js';

/** The example app and the guide beside it stay true to what an app can actually do. */
const read = (name: string) => readFileSync(new URL(`../examples/apps/${name}`, import.meta.url), 'utf8');

const EXTRAS = ['project', 'grants', 'colorScheme', 'onChange', 'onColorSchemeChange'];

describe('the example app', () => {
    const html = read('board-summary.html');

    it('fits the limit', () => {
        expect(Buffer.byteLength(html)).toBeLessThanOrEqual(MAX_APP_HTML_BYTES);
    });

    it('loads nothing from anywhere, which the sandbox would refuse', () => {
        expect(html).not.toMatch(/https?:|<link\b|src=|fetch\(/);
    });

    it('uses only what window.wilson offers', () => {
        const used = [...html.matchAll(/\bwilson\.(\w+)/g)].map(match => match[1]!);

        expect(used.length).toBeGreaterThan(0);
        expect(used.filter(name => !APP_METHOD_NAMES.includes(name) && !EXTRAS.includes(name))).toEqual([]);
    });
});

describe('the guide', () => {
    const guide = read('README.md');

    it.each([...APP_METHOD_NAMES, ...EXTRAS])('documents wilson.%s', name => {
        expect(guide).toContain(`wilson.${name}`);
    });

    it('states the limit in force', () => {
        expect(guide).toContain(`${MAX_APP_HTML_BYTES / 1024} KiB`);
    });
});
