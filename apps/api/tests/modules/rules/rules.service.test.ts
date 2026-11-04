import { describe, expect, it } from 'vitest';
import { StaticRuleStore } from '#modules/rules/rule.store.js';
import { RulesService } from '#modules/rules/rules.service.js';

const service = () => new RulesService(new StaticRuleStore());
const body = { id: 'no-raw-sql', statement: 'Queries go through Kysely', paths: ['src/**'] };

describe('RulesService', () => {
    it('defaults a new rule to blocker, and records a message nobody wrote', async () => {
        const rules = new StaticRuleStore();
        await expect(new RulesService(rules).create(body)).resolves.toMatchObject({ severity: 'blocker' });
        expect((await rules.revisions(undefined, 1))[0]?.message).toBe('Added no-raw-sql');
    });

    it.each([
        ['400 for a malformed rule', () => service().create({ ...body, paths: [] }), 400],
        ['404 for a change to no rule', () => service().update('nope', { severity: 'concern' }), 404],
        ['404 for removing no rule', () => service().remove('nope', {}), 404],
    ])('answers %s, with the reason', async (_name, call, statusCode) => {
        await expect(call()).rejects.toMatchObject({ statusCode, details: { reason: expect.any(String) } });
    });

    it('answers 409 for an id already taken', async () => {
        const rules = service();
        await rules.create(body);
        await expect(rules.create(body)).rejects.toMatchObject({ statusCode: 409 });
    });
});
