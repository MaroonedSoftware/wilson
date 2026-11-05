import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';
import { PostgresRuleStore, ruleMatcher, RuleRefusedError } from '#modules/rules/rule.store.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const fields = { statement: 'Queries go through Kysely', paths: ['apps/api/src/**'], severity: 'blocker' as const };

describe('PostgresRuleStore', () => {
    let store: PostgresRuleStore;

    beforeEach(() => {
        store = new PostgresRuleStore(new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run'), db);
    });

    it('answers with nothing for a project with no rules', async () => {
        expect(await store.list()).toEqual([]);
        expect(await store.get('no-raw-sql')).toBeUndefined();
    });

    it('creates a rule pointing at the revision that recorded it', async () => {
        const rule = await store.create('no-raw-sql', fields, 'first');

        expect(rule).toMatchObject({ id: 'no-raw-sql', ...fields });
        const [revision] = await store.revisions('no-raw-sql', 10);
        expect(revision).toMatchObject({ id: rule.revision, rule: 'no-raw-sql', message: 'first', snapshot: fields });
        expect(await store.list()).toHaveLength(1);
    });

    it('moves to a new revision on a change, and records nothing for a change to nothing', async () => {
        const first = await store.create('no-raw-sql', fields, 'first');

        const same = await store.update('no-raw-sql', { statement: `  ${fields.statement}  ` }, 'noop');
        expect(same.revision).toBe(first.revision);
        expect(await store.revisions('no-raw-sql', 10)).toHaveLength(1);

        const changed = await store.update('no-raw-sql', { severity: 'concern' }, 'softer');
        expect(changed.revision).not.toBe(first.revision);
        expect(changed).toMatchObject({ severity: 'concern', statement: fields.statement, paths: fields.paths });
        expect((await store.revisions('no-raw-sql', 10)).map(revision => revision.message)).toEqual(['softer', 'first']);
    });

    it('keeps the history when a rule is removed', async () => {
        await store.create('no-raw-sql', fields, 'first');
        await store.remove('no-raw-sql', 'gone');

        expect(await store.get('no-raw-sql')).toBeUndefined();
        const [removed] = await store.revisions(undefined, 10);
        expect(removed).toMatchObject({ rule: 'no-raw-sql', message: 'gone' });
        expect(removed?.snapshot).toBeUndefined();
    });

    it('refuses a duplicate, leaving no second revision', async () => {
        await store.create('no-raw-sql', fields, 'first');

        await expect(store.create('no-raw-sql', fields, 'again')).rejects.toMatchObject({ kind: 'duplicate' });
        expect(await store.revisions('no-raw-sql', 10)).toHaveLength(1);
    });

    it('refuses to change or remove a rule that does not exist', async () => {
        await expect(store.update('nope', { severity: 'concern' }, 'x')).rejects.toMatchObject({ kind: 'not-found' });
        await expect(store.remove('nope', 'x')).rejects.toMatchObject({ kind: 'not-found' });
    });

    it.each([
        ['a malformed id', 'No Spaces', fields],
        ['an empty statement', 'ok', { ...fields, statement: '   ' }],
        ['no globs', 'ok', { ...fields, paths: [] }],
        ['an empty glob', 'ok', { ...fields, paths: [' '] }],
        ['an absolute glob, which would never match', 'ok', { ...fields, paths: ['/etc/**'] }],
        ['a statement too long to send every review', 'ok', { ...fields, statement: 'x'.repeat(2001) }],
        ['an unknown severity', 'ok', { ...fields, severity: 'fatal' as never }],
    ])('refuses %s', async (_name, id, bad) => {
        await expect(store.create(id, bad, 'x')).rejects.toBeInstanceOf(RuleRefusedError);
        expect(await store.list()).toEqual([]);
    });
});

describe('ruleMatcher', () => {
    it('matches dotfiles, since a rule about a directory means all of it', () => {
        const matches = ruleMatcher(['apps/**']);
        expect(matches('apps/.config/x.ts')).toBe(true);
        expect(matches('packages/x.ts')).toBe(false);
    });

    it('matches any of several globs', () => {
        const matches = ruleMatcher(['*.md', 'src/**/*.ts']);
        expect(matches('README.md')).toBe(true);
        expect(matches('src/a/b.ts')).toBe(true);
        expect(matches('src/a/b.js')).toBe(false);
    });
});
