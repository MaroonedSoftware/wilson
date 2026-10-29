import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { ApiChatEngine } from '#modules/chat/api.chat.engine.js';
import { onChatEvent, type ChatStreamEvent } from '#modules/chat/chat.feed.js';
import type { ChatEngineChoice } from '#modules/chat/chat.engine.setting.js';
import { ChatMessageRepository } from '#modules/chat/chat.message.repository.js';
import { ChatPendingActionRepository } from '#modules/chat/chat.pending.action.repository.js';
import { ChatService, NEW_THREAD_TITLE, NOTHING_MORE, titleFrom } from '#modules/chat/chat.service.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import type { DB } from '#modules/data/db.js';
import { testDb } from '#tests/support/test.db.js';
import { fakeCatalog, fakeContainer, fakeHandler, refusal, type FakeCall } from './chat.fakes.js';
import { calls, says, scriptedModel } from './chat.model.fake.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const reasonOf = (err: unknown): unknown => (err as { details?: { reason?: unknown } }).details?.reason;
const statusOf = (err: unknown): unknown => (err as { statusCode?: unknown }).statusCode;

/**
 * The chat end to end on the 'api' engine — the AI SDK's own tool loop, driven by a scripted model —
 * over real thread, message and pending-action tables and a fake operation catalog. What these pin
 * is the chat's contract with the person: a read runs, a change waits for their decision and runs
 * once when they make it, and nothing they said is lost when the model cannot answer.
 */
describe('ChatService', () => {
    const setup = (steps: Parameters<typeof scriptedModel>[0]) => {
        const operationCalls: FakeCall[] = [];
        const catalog = fakeCatalog([
            fakeHandler('list_cards', true, operationCalls, { result: [{ id: '0007', stage: 'review' }] }),
            fakeHandler('move_card', false, operationCalls, { result: { id: '0007', stage: 'implementing' } }),
            fakeHandler('release_card', false, operationCalls, { fails: refusal('card 0007 holds no lease') }),
        ]);
        const actions = new ChatPendingActionRepository(db);
        const container = fakeContainer(actions);
        const model = scriptedModel(steps);
        const service = new ChatService(
            container,
            new ConsoleLogger(),
            new ChatThreadRepository(db),
            new ChatMessageRepository(db),
            actions,
            catalog,
            container.get(ProjectRepository),
            { api: new ApiChatEngine(model.registry), cli: undefined },
            async (): Promise<ChatEngineChoice> => ({ engine: 'api', provider: 'anthropic', model: 'claude-sonnet-5-5' }),
        );
        return { service, model, operationCalls };
    };

    const proposeMove = calls('propose_change', {
        name: 'move_card',
        project: 'wilson',
        arguments: { id: '0007', body: { stage: 'implementing' } },
        summary: 'Move 0007 to implementing.',
    });

    it('starts an untitled thread on the chosen engine, and names it after its first message', async () => {
        const { service } = setup([says('Hello.')]);

        const thread = await service.startThread();
        expect(thread).toMatchObject({ title: NEW_THREAD_TITLE, engine: 'api' });

        await service.sendMessage(thread.id, { text: 'What is waiting in review?\nAnd why?' });

        expect((await service.getThread(thread.id)).thread.title).toBe('What is waiting in review?');
    });

    it('runs a read the answer needs, and stores the answer with the operation it ran', async () => {
        const { service, operationCalls } = setup([
            calls('dispatch_readonly', { name: 'list_cards', project: 'wilson', arguments: { stage: 'review' } }, 'Looking. '),
            says('One card: 0007.'),
        ]);
        const thread = await service.startThread();

        const turn = await service.sendMessage(thread.id, { text: 'What is in review?', project: 'wilson' });

        expect(operationCalls).toEqual([{ name: 'list_cards', args: { stage: 'review' }, project: 'wilson' }]);
        expect(turn.message).toMatchObject({ seq: 1, role: 'user', content: 'What is in review?', operations: [] });
        expect(turn.reply).toMatchObject({
            seq: 2,
            role: 'assistant',
            content: 'Looking. One card: 0007.',
            operations: [{ name: 'list_cards', arguments: { stage: 'review' }, project: 'wilson', ok: true }],
        });
        expect(turn.proposed).toEqual([]);
    });

    it('streams a turn to anyone watching its thread: text, each read, each proposal, then done', async () => {
        const { service } = setup([
            calls('dispatch_readonly', { name: 'list_cards', project: 'wilson' }, 'Looking. '),
            calls('propose_change', { name: 'move_card', project: 'wilson', arguments: { id: '0007' }, summary: 'Move 0007.' }),
            says('Proposed.'),
        ]);
        const thread = await service.startThread();
        const heard: ChatStreamEvent[] = [];
        const stop = onChatEvent(thread.id, event => heard.push(event));

        const turn = await service.sendMessage(thread.id, { text: 'Move whatever is in review' });
        stop();

        expect(heard.map(event => event.event)).toEqual(['delta', 'operation', 'proposed', 'delta', 'done']);
        expect(heard[1]).toEqual({ event: 'operation', data: { name: 'list_cards', arguments: {}, project: 'wilson', ok: true } });
        expect(heard[2]).toMatchObject({ event: 'proposed', data: { id: turn.proposed[0]!.id, summary: 'Move 0007.' } });
        expect(heard.at(-1)).toEqual({ event: 'done', data: { seq: turn.reply.seq } });
    });

    it('streams why a turn failed', async () => {
        const { service } = setup([]);
        const thread = await service.startThread();
        const heard: ChatStreamEvent[] = [];
        const stop = onChatEvent(thread.id, event => heard.push(event));

        await service.sendMessage(thread.id, { text: 'hello?' }).catch(() => undefined);
        stop();

        expect(heard).toEqual([{ event: 'failed', data: { reason: expect.stringContaining('the chat could not answer') } }]);
    });

    it('tells the model which project the person is looking at', async () => {
        const { service, model } = setup([says('Sure.')]);
        const thread = await service.startThread();

        await service.sendMessage(thread.id, { text: 'hi', project: 'wilson' });

        expect(JSON.stringify(model.prompts[0])).toContain('looking at the \\"wilson\\" project');
    });

    it("replays the thread on the next turn, the earlier turn's tool results included", async () => {
        const { service, model } = setup([
            calls('dispatch_readonly', { name: 'list_cards', project: 'wilson' }),
            says('One card.'),
            says('It is 0007.'),
        ]);
        const thread = await service.startThread();
        await service.sendMessage(thread.id, { text: 'What is in review?' });

        await service.sendMessage(thread.id, { text: 'Which one?' });

        const replayed = JSON.stringify(model.prompts[2]);
        expect(replayed).toContain('What is in review?');
        expect(replayed).toContain('0007');
        expect(replayed).toContain('Which one?');
    });

    it('proposes a change without making it, then makes it once when the person confirms', async () => {
        const { service, operationCalls } = setup([proposeMove, says('I proposed moving 0007; confirm it to go ahead.'), says(NOTHING_MORE)]);
        const thread = await service.startThread();

        const turn = await service.sendMessage(thread.id, { text: 'Move 0007 to implementing', project: 'wilson' });

        expect(operationCalls).toEqual([]);
        expect(turn.proposed).toEqual([
            expect.objectContaining({ operation: 'move_card', project: 'wilson', summary: 'Move 0007 to implementing.', status: 'pending' }),
        ]);

        const decided = await service.decide(turn.proposed[0]!.id, { decision: 'confirm' });

        expect(decided).toMatchObject({ status: 'done', result: { id: '0007', stage: 'implementing' } });
        expect(operationCalls).toEqual([{ name: 'move_card', args: { id: '0007', body: { stage: 'implementing' } }, project: 'wilson' }]);

        const again = await service.decide(turn.proposed[0]!.id, { decision: 'confirm' }).catch(err => err);
        expect(statusOf(again)).toBe(409);
        expect(reasonOf(again)).toContain('already decided');
        expect(operationCalls).toHaveLength(1);
        await service.whenIdle();
    });

    describe('after a confirmed change', () => {
        it('carries on with the next change the person asked for, told how the first one went', async () => {
            const { service, model } = setup([
                proposeMove,
                says('First, the move.'),
                calls('propose_change', { name: 'release_card', project: 'wilson', arguments: { id: '0007' }, summary: 'Release 0007.' }),
                says('Moved. Next, the release.'),
            ]);
            const thread = await service.startThread();
            const { proposed } = await service.sendMessage(thread.id, { text: 'Move 0007 to implementing, then release it' });

            await service.decide(proposed[0]!.id, { decision: 'confirm' });
            await service.whenIdle();

            const note = JSON.stringify(model.prompts[2]);
            expect(note).toContain('not from the person');
            expect(note).toContain('It was made');
            const detail = await service.getThread(thread.id);
            expect(detail.messages.map(message => [message.role, message.content])).toEqual([
                ['user', 'Move 0007 to implementing, then release it'],
                ['assistant', 'First, the move.'],
                ['assistant', 'Moved. Next, the release.'],
            ]);
            expect(detail.actions.map(action => [action.operation, action.status])).toEqual([
                ['move_card', 'done'],
                ['release_card', 'pending'],
            ]);
        });

        it(`stores nothing when there is nothing more to say (${NOTHING_MORE})`, async () => {
            const { service } = setup([proposeMove, says('Proposed.'), says(NOTHING_MORE)]);
            const thread = await service.startThread();
            const { proposed } = await service.sendMessage(thread.id, { text: 'Move 0007' });
            const heard: ChatStreamEvent[] = [];
            const stop = onChatEvent(thread.id, event => heard.push(event));

            await service.decide(proposed[0]!.id, { decision: 'confirm' });
            await service.whenIdle();
            stop();

            expect((await service.getThread(thread.id)).messages).toHaveLength(2);
            expect(heard.at(-1)).toEqual({ event: 'done', data: { seq: 2 } });
        });

        it('tells the chat when the change failed, so it can say why', async () => {
            const { service, model } = setup([
                calls('propose_change', { name: 'release_card', project: 'wilson', arguments: { id: '0007' }, summary: 'Release 0007.' }),
                says('Proposed.'),
                says('The release failed: 0007 holds no lease, so there was nothing to release.'),
            ]);
            const thread = await service.startThread();
            const { proposed } = await service.sendMessage(thread.id, { text: 'Release 0007' });

            await service.decide(proposed[0]!.id, { decision: 'confirm' });
            await service.whenIdle();

            expect(JSON.stringify(model.prompts[2])).toContain('It failed: card 0007 holds no lease');
            expect((await service.getThread(thread.id)).messages.at(-1)?.content).toContain('holds no lease');
        });

        it('runs no follow-up for a declined change', async () => {
            const { service, model } = setup([proposeMove, says('Proposed.')]);
            const thread = await service.startThread();
            const { proposed } = await service.sendMessage(thread.id, { text: 'Move 0007' });

            await service.decide(proposed[0]!.id, { decision: 'decline' });
            await service.whenIdle();

            expect(model.prompts).toHaveLength(2);
        });

        it("replays the follow-up's note ahead of its answer, so the next turn reads in order", async () => {
            const { service, model } = setup([proposeMove, says('Proposed.'), says('Moved; anything else?'), says('Done for now.')]);
            const thread = await service.startThread();
            const { proposed } = await service.sendMessage(thread.id, { text: 'Move 0007' });
            await service.decide(proposed[0]!.id, { decision: 'confirm' });
            await service.whenIdle();

            await service.sendMessage(thread.id, { text: 'No, thanks' });

            const replayed = JSON.stringify(model.prompts[3]);
            expect(replayed.indexOf('not from the person')).toBeGreaterThan(-1);
            expect(replayed.indexOf('not from the person')).toBeLessThan(replayed.indexOf('Moved; anything else?'));
            expect(replayed.indexOf('Moved; anything else?')).toBeLessThan(replayed.indexOf('No, thanks'));
        });
    });

    it('runs nothing for a declined proposal, and refuses to confirm it afterwards', async () => {
        const { service, operationCalls } = setup([proposeMove, says('Proposed.')]);
        const thread = await service.startThread();
        const { proposed } = await service.sendMessage(thread.id, { text: 'Move 0007' });

        expect(await service.decide(proposed[0]!.id, { decision: 'decline' })).toMatchObject({ status: 'declined' });
        expect(statusOf(await service.decide(proposed[0]!.id, { decision: 'confirm' }).catch(err => err))).toBe(409);
        expect(operationCalls).toEqual([]);
    });

    it("records a confirmed change that fails as failed, in the operation's own words", async () => {
        const { service } = setup([
            calls('propose_change', { name: 'release_card', project: 'wilson', arguments: { id: '0007' }, summary: 'Release 0007.' }),
            says('Proposed.'),
            says(NOTHING_MORE),
        ]);
        const thread = await service.startThread();
        const { proposed } = await service.sendMessage(thread.id, { text: 'Release 0007' });

        expect(await service.decide(proposed[0]!.id, { decision: 'confirm' })).toMatchObject({ status: 'failed', error: 'card 0007 holds no lease' });
        await service.whenIdle();
    });

    it("shows a thread's messages and its actions together", async () => {
        const { service } = setup([proposeMove, says('Proposed.')]);
        const thread = await service.startThread();
        await service.sendMessage(thread.id, { text: 'Move 0007' });

        const detail = await service.getThread(thread.id);

        expect(detail.messages.map(message => message.role)).toEqual(['user', 'assistant']);
        expect(detail.actions).toEqual([expect.objectContaining({ operation: 'move_card', status: 'pending' })]);
    });

    it("keeps the person's message when the model cannot answer, and says why", async () => {
        const { service } = setup([]);
        const thread = await service.startThread();

        const failure = await service.sendMessage(thread.id, { text: 'Are you there?' }).catch(err => err);

        expect(statusOf(failure)).toBe(502);
        expect(reasonOf(failure)).toContain('the chat could not answer');
        expect((await service.getThread(thread.id)).messages).toEqual([expect.objectContaining({ role: 'user', content: 'Are you there?' })]);
    });

    it('refuses an empty message, and a thread that does not exist', async () => {
        const { service } = setup([]);
        const thread = await service.startThread();

        expect(statusOf(await service.sendMessage(thread.id, { text: '   ' }).catch(err => err))).toBe(400);
        expect(statusOf(await service.sendMessage('999999999', { text: 'hi' }).catch(err => err))).toBe(404);
        expect(statusOf(await service.getThread('999999999').catch(err => err))).toBe(404);
        expect(statusOf(await service.decide('999999999', { decision: 'confirm' }).catch(err => err))).toBe(404);
    });

    it('renames and archives a thread', async () => {
        const { service } = setup([]);
        const thread = await service.startThread();

        expect(await service.renameThread(thread.id, { title: '  triage  ' })).toMatchObject({ title: 'triage' });
        expect(statusOf(await service.renameThread(thread.id, { title: ' ' }).catch(err => err))).toBe(400);
        expect((await service.archiveThread(thread.id)).archivedAt).toBeDefined();
        expect((await service.listThreads()).map(listed => listed.id)).not.toContain(thread.id);
    });
});

describe('titleFrom', () => {
    it('takes the first line, cut to sixty characters', () => {
        expect(titleFrom('  short question  ')).toBe('short question');
        expect(titleFrom('first line\nsecond line')).toBe('first line');
        const long = titleFrom('x'.repeat(100));
        expect(long).toHaveLength(60);
        expect(long.endsWith('…')).toBe(true);
    });
});
