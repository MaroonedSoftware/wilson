import { describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE, resolveApiBase } from '#src/lib/api.config.js';

describe('resolveApiBase', () => {
    it('falls back to the local API when nothing is configured', () => {
        expect(resolveApiBase(undefined)).toBe(DEFAULT_API_BASE);
        expect(resolveApiBase('   ')).toBe(DEFAULT_API_BASE);
    });

    it('uses a configured base', () => {
        expect(resolveApiBase('https://wilson.internal')).toBe('https://wilson.internal');
    });

    it('drops a trailing slash, which would double up on every path', () => {
        expect(resolveApiBase('https://wilson.internal/')).toBe('https://wilson.internal');
    });

    it('treats / as same-origin, so every path stays relative to the page', () => {
        expect(resolveApiBase('/')).toBe('');
    });
});
