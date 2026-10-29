import { describe, expect, it } from 'vitest';
import { connectUrl } from '../src/worker.client.js';
import { ProjectRoots } from '../src/worker.roots.js';

describe('ProjectRoots', () => {
    const roots = new ProjectRoots();
    roots.update([{ project: 'tga', codeRoot: '/srv/tga/', worktreeRoot: '/srv/wt', runRoot: '/srv/run' }]);

    it('lets through a path inside any of a project’s three roots, or a root itself', () => {
        expect(roots.checkPath('/srv/tga')).toBeUndefined();
        expect(roots.checkPath('/srv/tga/src/index.ts')).toBeUndefined();
        expect(roots.checkPath('/srv/wt/0001/README.md')).toBeUndefined();
        expect(roots.checkPath('/srv/run/cards/0001/plan.md')).toBeUndefined();
    });

    it('refuses a path outside them, one that only shares a prefix, one that climbs out, and a relative one', () => {
        expect(roots.checkPath('/etc/passwd')).toBe('outside this host’s project roots');
        expect(roots.checkPath('/srv/tga-other/x')).toBe('outside this host’s project roots');
        expect(roots.checkPath('/srv/wt/../../etc/passwd')).toBe('outside this host’s project roots');
        expect(roots.checkPath('srv/tga')).toBe('not an absolute path');
    });

    it('lets a command run from / for the probe, and nowhere else outside the roots', () => {
        expect(roots.checkCwd('/')).toBeUndefined();
        expect(roots.checkCwd('/srv/wt/0001')).toBeUndefined();
        expect(roots.checkCwd('/home')).toBe('outside this host’s project roots');
    });

    it('refuses everything before it has been told any project', () => {
        expect(new ProjectRoots().checkPath('/srv/tga')).toBe('this worker serves no project yet');
    });
});

describe('connectUrl', () => {
    it('turns Wilson’s API URL into its worker endpoint’s WebSocket URL', () => {
        expect(connectUrl('http://tower:13100')).toBe('ws://tower:13100/api/workers/connect');
        expect(connectUrl('https://wilson.example.ts.net/')).toBe('wss://wilson.example.ts.net/api/workers/connect');
        expect(() => connectUrl('ftp://tower')).toThrow('WILSON_URL must be an http or https URL');
    });
});
