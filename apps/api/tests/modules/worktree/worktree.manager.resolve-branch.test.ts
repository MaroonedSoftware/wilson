import { describe, expect, it } from 'vitest';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const card = (overrides: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id: '0042', title: 'Port allocator', stage: 'implementing', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body: '',
});

/**
 * Card 0095: `resolveBranch` is the one place that decides "which branch is this card's work on" —
 * the recorded `frontmatter.branch` once one exists, `branchName`'s derivation from the current title
 * otherwise. No filesystem or git needed here; this is pure logic over a `Card`, unlike the rest of
 * `worktree.manager.test.ts`, which exercises real git.
 */
describe('WorktreeManager.resolveBranch', () => {
    const manager = new WorktreeManager(
        new StaticBoardConfig('test', '/tmp/wilson-test-board', '/tmp/wilson-test-code', '/tmp/wilson-test-worktrees', '/tmp/wilson-test-run'),
        silentLogger as never,
    );

    it('derives from the title when no branch is recorded, exactly what branchName itself would return', () => {
        expect(manager.resolveBranch(card())).toBe(manager.branchName('0042', 'Port allocator'));
        expect(manager.resolveBranch(card())).toBe('card/0042-port-allocator');
    });

    it('prefers the recorded branch over the title, even once the title has changed since it was recorded', () => {
        const renamed = card({ title: 'A brand new title', branch: 'card/0042-port-allocator' });

        expect(manager.resolveBranch(renamed)).toBe('card/0042-port-allocator');
        // If this fell back to the title, a rename would silently point the runner at a different,
        // nonexistent branch — the exact defect this card fixes.
        expect(manager.resolveBranch(renamed)).not.toBe(manager.branchName('0042', 'A brand new title'));
    });

    it('never re-derives once a branch is recorded, even for a title that would slugify to nothing', () => {
        const renamed = card({ title: '!!!', branch: 'card/0042-port-allocator' });
        expect(manager.resolveBranch(renamed)).toBe('card/0042-port-allocator');
    });
});
