import { describe, expect, it } from 'vitest';
import { actionFields, fieldLabel, prettyArguments } from '../src/lib/chat.arguments.js';

describe('actionFields', () => {
    it('opens a request body and makes its names readable', () => {
        expect(actionFields({ id: '0003', body: { stage: 'review', web_access: 'none' } })).toEqual([
            { label: 'ID', value: '0003', kind: 'line' },
            { label: 'Stage', value: 'review', kind: 'line' },
            { label: 'Web access', value: 'none', kind: 'line' },
        ]);
    });

    it('keeps a body whole when its names clash, so nothing reads twice', () => {
        const fields = actionFields({ id: '1', body: { id: '2' } });

        expect(fields.map(f => f.label)).toEqual(['ID', 'Body']);
        expect(fields[1]).toMatchObject({ kind: 'json' });
        expect(fields[1]!.value).toContain('"2"');
    });

    it('treats a body that is not an object like any other argument', () => {
        expect(actionFields({ body: 'text' })).toEqual([{ label: 'Body', value: 'text', kind: 'line' }]);
    });

    it("reads a body inside a body as the card's text, after the short values", () => {
        const fields = actionFields({ body: { body: '## Goal\n\nRead it.', stage: 'parking-lot', title: 'A card' } });

        expect(fields.map(f => f.label)).toEqual(['Stage', 'Title', 'Body']);
        expect(fields[2]).toEqual({ label: 'Body', value: '## Goal\n\nRead it.', kind: 'prose' });
    });

    it('calls long text prose even on one line', () => {
        expect(actionFields({ note: 'a'.repeat(120) })[0]!.kind).toBe('line');
        expect(actionFields({ note: 'a'.repeat(121) })[0]!.kind).toBe('prose');
    });

    it('shows every kind of value', () => {
        const fields = actionFields({ a: null, b: true, c: 3, d: '', e: ['x'], f: { g: 1 } });

        expect(fields.slice(0, 4).map(f => [f.value, f.kind])).toEqual([
            ['none', 'line'],
            ['true', 'line'],
            ['3', 'line'],
            ['(empty)', 'line'],
        ]);
        expect(fields[4]).toMatchObject({ label: 'E', kind: 'json' });
        expect(fields[4]!.value).toContain('"x"');
        expect(fields[5]!.value).toContain('"g": 1');
    });

    it('has no fields for no arguments', () => {
        expect(actionFields({})).toEqual([]);
    });

    it('still shows arguments that are not an object', () => {
        expect(actionFields(3)).toEqual([{ label: 'Arguments', value: '3', kind: 'json' }]);
    });
});

describe('fieldLabel', () => {
    it.each([
        ['webAccess', 'Web access'],
        ['web_access', 'Web access'],
        ['web-access', 'Web access'],
        ['cardId', 'Card ID'],
        ['id', 'ID'],
        ['title', 'Title'],
        ['_', '_'],
    ])('reads %s as %s', (name, label) => {
        expect(fieldLabel(name)).toBe(label);
    });
});

describe('prettyArguments', () => {
    it('indents and leaves text alone', () => {
        const raw = prettyArguments({ body: { title: 'café <b>' } });

        expect(raw).toContain('\n');
        expect(raw).toContain('café <b>');
    });
});
