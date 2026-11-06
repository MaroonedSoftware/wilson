import { describe, expect, it } from 'vitest';
import { parseStages, StageConfigError } from '#modules/stages/stage.config.js';
import { lanesFromDocument } from '#modules/stages/lane.rows.js';
import { isHostAllowed, isWebAllowEntry } from '#modules/stages/web.allow.js';

/** Card 0019: a project's `webAllow` list and the matcher card 0020's guard will ask. */

describe('isWebAllowEntry', () => {
    it.each(['github.com', '*.githubusercontent.com', 'GitHub.COM', 'localhost', 'a-b.example.org'])('accepts %s', entry => {
        expect(isWebAllowEntry(entry)).toBe(true);
    });

    it.each([
        'https://github.com',
        'github.com/path',
        'github.com:443',
        ' github.com',
        'git hub.com',
        'github.com ',
        '',
        '*',
        '*.',
        'foo.*.com',
        '**.github.com',
        'github..com',
        '.github.com',
        '-github.com',
        'user@github.com',
    ])('rejects %j', entry => {
        expect(isWebAllowEntry(entry)).toBe(false);
    });
});

describe('isHostAllowed', () => {
    const allow = ['github.com', '*.githubusercontent.com'];

    it('allows an exact host', () => {
        expect(isHostAllowed('https://github.com/foo/bar', allow)).toBe(true);
        expect(isHostAllowed('http://github.com', allow)).toBe(true);
    });

    it('does not let an exact entry match a subdomain', () => {
        expect(isHostAllowed('https://api.github.com/', allow)).toBe(false);
    });

    it('lets a wildcard match subdomains but not the bare domain', () => {
        expect(isHostAllowed('https://raw.githubusercontent.com/x', allow)).toBe(true);
        expect(isHostAllowed('https://a.b.githubusercontent.com/x', allow)).toBe(true);
        expect(isHostAllowed('https://githubusercontent.com/x', allow)).toBe(false);
        expect(isHostAllowed('https://evilgithubusercontent.com/x', allow)).toBe(false);
    });

    it('is case-insensitive on both sides', () => {
        expect(isHostAllowed('https://GitHub.COM/x', allow)).toBe(true);
        expect(isHostAllowed('https://github.com/x', ['GITHUB.com'])).toBe(true);
        expect(isHostAllowed('https://RAW.GithubUserContent.com/x', allow)).toBe(true);
    });

    it('does not match a lookalike suffix', () => {
        expect(isHostAllowed('https://github.com.evil.com/', allow)).toBe(false);
        expect(isHostAllowed('https://notgithub.com/', allow)).toBe(false);
    });

    it('compares the host, not userinfo', () => {
        expect(isHostAllowed('https://github.com@evil.com/', allow)).toBe(false);
        expect(isHostAllowed('https://github.com:pw@evil.com/', allow)).toBe(false);
        expect(isHostAllowed('https://evil.com@github.com/', allow)).toBe(true);
    });

    it('ignores the port and path', () => {
        expect(isHostAllowed('https://github.com:8443/a?b#c', allow)).toBe(true);
    });

    it.each(['ftp://github.com/', 'file://github.com/etc/passwd', 'javascript:alert(1)', 'data:text/html,github.com', 'ws://github.com/'])(
        'never allows a non-http(s) URL: %s',
        url => {
            expect(isHostAllowed(url, allow)).toBe(false);
        },
    );

    it('refuses what is not a URL', () => {
        expect(isHostAllowed('github.com', allow)).toBe(false);
        expect(isHostAllowed('', allow)).toBe(false);
    });

    it('allows nothing with an empty list', () => {
        expect(isHostAllowed('https://github.com/', [])).toBe(false);
    });

    it('ignores an invalid entry rather than matching on it', () => {
        expect(isHostAllowed('https://github.com/', ['https://github.com'])).toBe(false);
    });
});

const doc = (project: string) => `
${project}
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: do it
    onPass: done
    onFail: implementing
`;

describe('stage config webAllow', () => {
    it('defaults to an empty list when omitted, as before', () => {
        const stages = parseStages(doc(''));
        expect(stages.webAllow).toEqual([]);
        expect(stages.alwaysAllowed).toEqual([]);
    });

    it('loads valid entries', () => {
        const stages = parseStages(doc('webAllow:\n  - github.com\n  - "*.githubusercontent.com"'));
        expect(stages.webAllow).toEqual(['github.com', '*.githubusercontent.com']);
    });

    it.each(['https://github.com', 'github.com/x', 'github.com:443', 'git hub.com'])('refuses %j, naming the entry', entry => {
        const load = () => parseStages(doc(`webAllow:\n  - github.com\n  - ${JSON.stringify(entry)}`));
        expect(load).toThrow(StageConfigError);
        expect(load).toThrow(`webAllow entry "${entry}"`);
    });

    it('carries the list into the lane rows', () => {
        const config = lanesFromDocument(doc('webAllow:\n  - github.com'), new Map(), 'test');
        expect(config.project.webAllow).toEqual(['github.com']);
        expect(lanesFromDocument(doc(''), new Map(), 'test').project.webAllow).toEqual([]);
    });
});
