import { describe, expect, it } from 'vitest';
import type { AuthenticationSession } from '@maroonedsoftware/authentication';
import { AppsService, MAX_APP_HTML_BYTES } from '#modules/apps/apps.service.js';
import { MAX_PROPOSED_APP_HTML_BYTES, PROPOSE_APP_DESCRIPTION, PROPOSED_APP_OPERATION } from '#modules/chat/chat.app.proposal.js';
import { orchestratorSession } from '#modules/goal/orchestrator.session.js';
import { AppGrant } from '#src/generated/apps.js';
import { QUESTION_TTL } from '#modules/chat/chat.questions.js';
import { chatTools, PROPOSAL_TTL, RESULT_CAP, type ChatTool, type ChatToolEvent } from '#modules/chat/chat.tools.js';
import {
    fakeCatalog,
    fakeContainer,
    fakeHandler,
    fakeProposals,
    fakeQuestions,
    fakeSession,
    refusal,
    turnContext,
    type FakeCall,
} from './chat.fakes.js';

/**
 * The tools the chat's agent gets. The rule they enforce is the chat's whole safety model: the
 * agent may run a read, but a change only ever becomes a pending action and a question only ever a
 * pending question, both for the person alone to decide.
 */
describe('the chat tools', () => {
    const setup = (calls: FakeCall[] = []) => {
        const proposals = fakeProposals();
        const questions = fakeQuestions();
        const catalog = fakeCatalog([
            fakeHandler('list_cards', true, calls, { result: [{ id: '0007', stage: 'review' }] }),
            fakeHandler('get_card', true, calls, { fails: refusal('card 0099 not found') }),
            fakeHandler('get_card_diff', true, calls, { result: 'x'.repeat(RESULT_CAP * 2) }),
            fakeHandler('move_card', false, calls, { result: { id: '0007' } }),
        ]);
        const context = turnContext(fakeContainer(proposals.repository, questions.repository), '42');
        const events: ChatToolEvent[] = [];
        context.emit = event => events.push(event);
        const tools = chatTools(catalog, context);
        const tool = (name: string): ChatTool => tools.find(candidate => candidate.name === name)!;
        return { tool, context, events, proposals, questions, calls };
    };

    it('offers exactly these tools, none of which makes a change', () => {
        expect(
            chatTools(fakeCatalog([]), turnContext(fakeContainer()))
                .map(tool => tool.name)
                .sort(),
        ).toEqual(['ask_user', 'describe', 'discover', 'dispatch_readonly', 'propose_app', 'propose_change']);
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

    it('reads a large result to its end in windows, each naming the next offset', async () => {
        const { tool } = setup();
        const read = (offset?: number) =>
            tool('dispatch_readonly').execute({ name: 'get_card_diff', project: 'wilson', arguments: { id: '0007' }, offset });

        expect(await read()).toContain(`repeat this call with offset ${RESULT_CAP} to read on`);
        expect(await read(RESULT_CAP)).toContain(`repeat this call with offset ${RESULT_CAP * 2} to read on`);

        const last = await read(RESULT_CAP * 2);
        expect(last).not.toContain('read on');
        expect(last.length).toBeLessThan(10);
    });

    it('says so when an offset is past the end of the result', async () => {
        const { tool } = setup();

        const answer = await tool('dispatch_readonly').execute({ name: 'list_cards', project: 'wilson', offset: 5000 });

        expect(answer).toContain('Nothing at offset 5000');
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

    const oneQuestion = {
        header: 'Database',
        text: 'Which database should this project use?',
        options: [
            { label: 'Postgres', description: 'The default for this repo.' },
            { label: 'SQLite', description: 'Simpler, file-based.' },
        ],
        multiSelect: false,
    };

    it('asks a question, storing one pending question for the whole set, without answering it', async () => {
        const { tool, context, events, questions } = setup();

        const answer = await tool('ask_user').execute({ questions: [oneQuestion] });

        expect(questions.stored).toEqual([expect.objectContaining({ threadId: '42', questions: [oneQuestion], status: 'pending' })]);
        expect(context.asked).toEqual(questions.stored);
        expect(events).toEqual([{ type: 'asked', question: questions.stored[0] }]);
        expect(answer).toContain(`Asked as question ${questions.stored[0]!.id}`);
        expect(answer).toContain('has not been answered');
        expect(answer).toContain(`${QUESTION_TTL.as('minutes')} minutes`);
    });

    it("refuses input breaking the schema's limits, by throwing before execute is ever called", () => {
        const { tool, questions } = setup();
        const schema = tool('ask_user').input;

        expect(schema.safeParse({ questions: Array.from({ length: 5 }, () => oneQuestion) }).success).toBe(false);
        expect(schema.safeParse({ questions: [{ ...oneQuestion, options: [oneQuestion.options[0]] }] }).success).toBe(false);
        expect(schema.safeParse({ questions: [{ ...oneQuestion, options: Array.from({ length: 5 }, () => oneQuestion.options[0]) }] }).success).toBe(
            false,
        );
        expect(schema.safeParse({ questions: [{ ...oneQuestion, header: 'x'.repeat(61) }] }).success).toBe(false);
        expect(questions.stored).toEqual([]);
    });
});

describe('propose_app', () => {
    const ARGS = { slug: 'open-cards', name: ' Open cards ', description: 'What is open', html: '<h1>open</h1>', requestedGrants: ['board.read'] };

    const setup = (installed: string[] = [], session: AuthenticationSession = fakeSession) => {
        const proposals = fakeProposals();
        const container = fakeContainer(proposals.repository, undefined, registry => {
            registry.register(AppsService).useValue({ exists: async (slug: string) => installed.includes(slug) } as unknown as AppsService);
        });
        const context = { ...turnContext(container, '42'), session };
        const tools = chatTools(fakeCatalog([]), context);
        return { tools, tool: tools.find(candidate => candidate.name === 'propose_app'), proposals, context };
    };

    it('stores a pending action under the reserved operation, with its own summary, and installs nothing', async () => {
        const { tool, proposals, context } = setup();

        const answer = await tool!.execute(ARGS);

        expect(answer).toContain('has not been installed');
        expect(proposals.stored).toEqual([
            expect.objectContaining({
                threadId: '42',
                operation: PROPOSED_APP_OPERATION,
                arguments: { ...ARGS, name: 'Open cards' },
                summary: 'Install a new app, "Open cards" (1 KiB).',
                status: 'pending',
            }),
        ]);
        expect(context.proposed).toEqual(proposals.stored);
    });

    it('does not hand the HTML back to the model', async () => {
        expect(await setup().tool!.execute(ARGS)).not.toContain('<h1>');
    });

    it('refuses a slug that is taken, since it cannot replace an app', async () => {
        const { tool, proposals } = setup(['open-cards']);

        expect(await tool!.execute(ARGS)).toContain('already installed');
        expect(proposals.stored).toEqual([]);
    });

    it('refuses a malformed slug', async () => {
        const { tool, proposals } = setup();

        expect(await tool!.execute({ ...ARGS, slug: 'Open Cards' })).toContain('is not a slug');
        expect(proposals.stored).toEqual([]);
    });

    it('refuses a file over the proposal limit, which is below the limit for an uploaded one', async () => {
        const { tool, proposals } = setup();

        expect(await tool!.execute({ ...ARGS, html: 'x'.repeat(MAX_PROPOSED_APP_HTML_BYTES + 1) })).toContain('at most');
        expect(proposals.stored).toEqual([]);
        expect(MAX_PROPOSED_APP_HTML_BYTES).toBeLessThan(MAX_APP_HTML_BYTES);
    });

    it('is not offered to a goal wake-up, which nobody asked for', () => {
        const { tools } = setup([], orchestratorSession());

        expect(tools.map(({ name }) => name)).not.toContain('propose_app');
        expect(tools.map(({ name }) => name)).toContain('propose_change');
    });

    it('tells the agent every grant there is, and the calls that need none', () => {
        for (const grant of AppGrant.options) expect(PROPOSE_APP_DESCRIPTION).toContain(grant);
        expect(PROPOSE_APP_DESCRIPTION).toContain('wilson.openCard(id) needs no grant');
    });

    it('cannot be reached through propose_change', async () => {
        const { tools, proposals } = setup();
        const change = tools.find(candidate => candidate.name === 'propose_change')!;

        const answer = await change.execute({ name: PROPOSED_APP_OPERATION, arguments: ARGS, summary: 'Install it.' });

        expect(answer).toContain('There is no operation named');
        expect(proposals.stored).toEqual([]);
    });
});
