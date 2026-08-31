import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Card 0172: `apps/web/public/favicon.svg` and its `<link>` in `index.html` are new — before this
 * card `apps/web/public/` did not exist at all and `index.html` had no `<head>` beyond a title. This
 * card's own acceptance criteria call out both halves by name ("`apps/web/public/favicon.svg` exists
 * and `index.html` references it"), so this asserts them directly against the files on disk rather
 * than relying on a build failure to notice a broken or missing reference.
 *
 * `currentColor` (how every other brand mark in this app tints itself) is meaningless for a favicon —
 * there is no surrounding text color for the browser tab to hand it — so the Constraints require the
 * light/dark swap to be baked into the SVG itself via a `prefers-color-scheme` media query. That is
 * asserted here too, since nothing else in the suite renders or inspects the favicon file.
 */
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');

describe('the favicon', () => {
    it('exists at apps/web/public/favicon.svg', () => {
        expect(existsSync(join(webRoot, 'public/favicon.svg'))).toBe(true);
    });

    it('is referenced from index.html as the page icon', () => {
        const html = readFileSync(join(webRoot, 'index.html'), 'utf8');
        expect(html).toMatch(/<link[^>]*rel=["']icon["'][^>]*href=["']\/favicon\.svg["']/);
    });

    it('bakes light/dark directly into the SVG via prefers-color-scheme, since currentColor cannot reach a browser tab', () => {
        const svg = readFileSync(join(webRoot, 'public/favicon.svg'), 'utf8');
        expect(svg).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
        expect(svg).not.toMatch(/fill=["']currentColor["']/);
    });
});
