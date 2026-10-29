import { describe, expect, it } from 'vitest';
import { chatTools, PROPOSAL_TTL, RESULT_CAP, type ChatTool, type ChatToolEvent } from '#modules/chat/chat.tools.js';
import { fakeCatalog, fakeContainer, fakeHandler, fakeProposals, refusal, turnContext, type FakeCall } from './chat.fakes.js';

/**
 * The four tools the chat's agent gets. The rule they enforce is the chat's whole safety model: the
 * agent may run a read, but a change only ever becomes a pending action for the person to decide.
 */
describe('the chat tools', () => {
    const setup = (calls: FakeCall[] = []) => {
        const proposals = fakeProposals();
        const catalog = fakeCatalog([
            fakeHandler('list_cards', true, calls, { result: [{ id: '0007', stage: 'review' }] }),
            fakeHandler('get_card', true, calls, { fails: refusal('card 0099 not found') }),
            fakeHandler('get_card_diff', true, calls, { result: 'x'.repeat(RESULT_CAP * 2) }),
            fakeHandler('move_card', false, calls, { result: { id: '0007' } }),
        ]);
        const context = turnContext(fakeContainer(proposals.repository), '42');
        const events: ChatToolEvent[] = [];
        context.emit = event => events.push(event);
        const tools = chatTools(catalog, context);
        const tool = (name: string): ChatTool => tools.find(candidate => candidate.name === name)!;
        return { tool, context, events, proposals, calls };
    };

    it('offers exactly four tools, none of which makes a change', () => {
        expect(
            chatTools(fakeCatalog([]), turnContext(fakeContainer()))
                .map(tool => tool.name)
                .sort(),
        ).toEqual(['describe', 'discover', 'dispatch_readonly', 'propose_change']);
    });

    it('finds operations by keyword, saying which are reads', async () => {
        const { tool } = setup();

        const answer = JSON.parse(await tool('discover').execute({ query: 'card', readOnly: false }));

        expect(answer).toEqual([{ name: 'move_card', description: 'Change move card', readOnly: false }]);
    });

    it("describes an operation's arguments, and says so when there is no such operation", async () => {
        const { tool } = setup();

        expect(JSON.parse(await tool('describe').execute({ name: 'move_card' }))).toMatchObject({
            name: 'move_card',
            inputSchema: { type: 'object' },
        });
        expect(await tool('describe').execute({ name: 'drop_everything' })).toContain('There is no operation named "drop_everything"');
    });

    it('runs a read in the project it names and records it on the turn', async () => {
        const { tool, context, events, calls } = setup();

        const answer = await tool('dispatch_readonly').execute({ name: 'list_cards', project: 'wilson', arguments: { stage: 'review' } });

        expect(JSON.parse(answer)).toEqual([{ id: '0007', stage: 'review' }]);
        expect(calls).toEqual([{ name: 'list_cards', args: { stage: 'review' }, project: 'wilson' }]);
        const operation = { name: 'list_cards', arguments: { stage: 'review' }, project: 'wilson', ok: true };
        expect(context.operations).toEqual([operation]);
        expect(events).toEqual([{ type: 'operation', operation }]);
    });

    it('refuses to run a change, and runs nothing', async () => {
        const { tool, context, calls } = setup();

        const answer = await tool('dispatch_readonly').execute({ name: 'move_card', project: 'wilson', arguments: { id: '0007' } });

        expect(answer).toContain('Propose it instead');
        expect(calls).toEqual([]);
        expect(context.operations).toEqual([]);
    });

    it("answers a failed read with the operation's own reason, and records it as failed", async () => {
        const { tool, context } = setup();

        const answer = await tool('dispatch_readonly').execute({ name: 'get_card', project: 'wilson', arguments: { id: '0099' } });

        expect(answer).toBe('"get_card" failed: card 0099 not found');
        expect(context.operations).toEqual([{ name: 'get_card', arguments: { id: '0099' }, project: 'wilson', ok: false }]);
    });

    it('cuts a large result before the model sees it, and says so', async () => {
        const { tool } = setup();

        const answer = await tool('dispatch_readonly').execute({ name: 'get_card_diff', project: 'wilson', arguments: { id: '0007' } });

        expect(answer.length).toBeLessThan(RESULT_CAP + 200);
        expect(answer).toContain(`cut at ${RESULT_CAP}`);
    });

    it('proposes a change as a pending action, without running it', async () => {
        const { tool, context, events, proposals, calls } = setup();
        const args = { id: '0007', body: { stage: 'implementing' } };

        const answer = await tool('propose_change').execute({
            name: 'move_card',
            project: 'wilson',
            arguments: args,
            summary: 'Move 0007 to implementing.',
        });

        expect(calls).toEqual([]);
        expect(proposals.stored).toEqual([
            expect.objectContaining({
                threadId: '42',
                project: 'wilson',
                operation: 'move_card',
                arguments: args,
                summary: 'Move 0007 to implementing.',
            }),
        ]);
        expect(context.proposed).toEqual(proposals.stored);
        expect(events).toEqual([{ type: 'proposed', action: proposals.stored[0] }]);
        expect(answer).toContain('It has not been made');
        expect(answer).toContain(`${PROPOSAL_TTL.as('minutes')} minutes`);
    });

    it('refuses to propose a read, or an operation that does not exist', async () => {
        const { tool, proposals } = setup();

        expect(await tool('propose_change').execute({ name: 'list_cards', summary: 'List cards.' })).toContain('Run it directly');
        expect(await tool('propose_change').execute({ name: 'drop_everything', summary: 'Drop it.' })).toContain('There is no operation');
        expect(proposals.stored).toEqual([]);
    });
});
