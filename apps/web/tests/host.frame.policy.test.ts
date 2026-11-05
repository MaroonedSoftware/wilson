import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `frame-src 'none'` on the page that hosts an app is what stops the app's frame navigating itself
 * away with data in the URL. No browser runs here, so these pin that both servers keep sending it.
 * That it works was measured in Brave.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe("the host page's frame-src", () => {
    it('is sent by nginx with the page, in the block every page ends up at', () => {
        const shell = /location = \/index\.html \{([^}]*)\}/.exec(read('../../../deploy/web.nginx.conf'))?.[1];

        expect(shell).toContain(`add_header Content-Security-Policy "frame-src 'none'";`);
    });

    it('sends every page route to that block', () => {
        expect(read('../../../deploy/web.nginx.conf')).toContain('try_files $uri $uri/ /index.html;');
    });

    it('is sent by the dev server too', () => {
        expect(read('../vite.config.ts')).toContain(`'Content-Security-Policy': "frame-src 'none'"`);
    });
});
