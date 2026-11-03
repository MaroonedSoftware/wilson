import { describe, expect, it } from 'vitest';
import { captureLineAnchor, locateLineAnchor, type LineAnchor } from '#modules/review/review.anchor.js';
import type { DiffFileEntry } from '#modules/worktree/worktree.manager.js';

const file = (patch: string[], path = 'a.ts'): DiffFileEntry => ({ path, status: 'modified', patch: patch.join('\n'), truncated: false });

const ORIGINAL = file(['@@ -1,4 +1,4 @@', ' first', '-gone', '+added', ' third', ' fourth']);

describe('captureLineAnchor', () => {
    it('captures an added line and its neighbours on the new side', () => {
        expect(captureLineAnchor(ORIGINAL, 'new', 2)).toEqual({
            file: 'a.ts',
            side: 'new',
            lineText: 'added',
            contextBefore: ['first'],
            contextAfter: ['third', 'fourth'],
        });
    });

    it('captures a removed line on the old side, skipping lines only the new side has', () => {
        expect(captureLineAnchor(ORIGINAL, 'old', 2)).toMatchObject({
            lineText: 'gone',
            contextBefore: ['first'],
            contextAfter: ['third', 'fourth'],
        });
    });

    it('answers undefined for a line the diff does not show', () => {
        expect(captureLineAnchor(ORIGINAL, 'new', 99)).toBeUndefined();
    });
});

describe('locateLineAnchor', () => {
    const anchorOn = (side: 'old' | 'new', line: number): LineAnchor => captureLineAnchor(ORIGINAL, side, line)!;

    it('finds a line where it was', () => {
        expect(locateLineAnchor(anchorOn('new', 2), [ORIGINAL])).toEqual({ location: 'found', currentLine: 2 });
    });

    it('follows a line that moved', () => {
        const moved = file(['@@ -1,4 +5,4 @@', ' first', '-gone', '+added', ' third', ' fourth']);

        expect(locateLineAnchor(anchorOn('new', 2), [moved])).toEqual({ location: 'found', currentLine: 6 });
    });

    it('finds a removed line on the old side', () => {
        const moved = file(['@@ -11,4 +11,4 @@', ' first', '-gone', '+added', ' third', ' fourth']);

        expect(locateLineAnchor(anchorOn('old', 2), [moved])).toEqual({ location: 'found', currentLine: 12 });
    });

    it('does not find a removed line on the new side', () => {
        const anchor = { ...anchorOn('new', 2), lineText: 'gone' };

        expect(locateLineAnchor(anchor, [ORIGINAL])).toEqual({ location: 'outdated' });
    });

    it('takes a single match even when its neighbours changed', () => {
        const rewritten = file(['@@ -1,2 +1,3 @@', ' other', '+added', ' else']);

        expect(locateLineAnchor(anchorOn('new', 2), [rewritten])).toEqual({ location: 'found', currentLine: 2 });
    });

    it('uses neighbours to choose between repeated lines', () => {
        const repeated = file(['@@ -1,8 +1,8 @@', ' nope', '-x', '+added', ' nope', ' first', '-x', '+added', ' third', ' fourth']);

        expect(locateLineAnchor(anchorOn('new', 2), [repeated])).toEqual({ location: 'found', currentLine: 5 });
    });

    it('calls a tie between repeated lines outdated rather than guess', () => {
        const tied = file(['@@ -1,4 +1,4 @@', ' p', '+added', ' q', '@@ -9,4 +9,4 @@', ' r', '+added', ' s']);

        expect(locateLineAnchor(anchorOn('new', 2), [tied])).toEqual({ location: 'outdated' });
    });

    it('calls a line that is gone, a file not in the diff and a truncated file outdated', () => {
        const anchor = anchorOn('new', 2);

        expect(locateLineAnchor(anchor, [file(['@@ -1 +1 @@', '+something else'])])).toEqual({ location: 'outdated' });
        expect(locateLineAnchor(anchor, [])).toEqual({ location: 'outdated' });
        expect(locateLineAnchor(anchor, [{ path: 'a.ts', status: 'modified', patch: '', truncated: true }])).toEqual({ location: 'outdated' });
    });
});
