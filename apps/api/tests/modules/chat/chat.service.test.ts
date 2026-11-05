import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticationSession } from '@maroonedsoftware/authentication';
import type { Kysely } from 'kysely';
import { Duration } from 'luxon';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { PolicyService } from '@maroonedsoftware/policies';
import { AppsRepository } from '#modules/apps/apps.repository.js';
import { AppsService } from '#modules/apps/apps.service.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { ApiChatEngine } from '#modules/chat/api.chat.engine.js';
import { PROPOSED_APP_OPERATION } from '#modules/chat/chat.app.proposal.js';
import { ChatAttachmentRepository } from '#modules/chat/chat.attachment.repository.js';
import { onChatEvent, type ChatStreamEvent } from '#modules/chat/chat.feed.js';
import type { ChatEngineChoice } from '#modules/chat/chat.engine.setting.js';
import { ChatMessageRepository } from '#modules/chat/chat.message.repository.js';
import { ChatPendingActionRepository } from '#modules/chat/chat.pending.action.repository.js';
import { ChatQuestionRepository } from '#modules/chat/chat.question.repository.js';
import {
    ChatService,
    IMAGE_THREAD_TITLE,
    MAX_IMAGES_PER_MESSAGE,
    NEW_THREAD_TITLE,
    REPLAYED_IMAGE_MESSAGES,
    NOTHING_MORE,
    titleFrom,
} from '#modules/chat/chat.service.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import { ChatUsageRepository } from '#modules/chat/chat.usage.repository.js';
import type { DB } from '#modules/data/db.js';
import { GoalRepository } from '#modules/goal/goal.repository.js';
import { testDb } from '#tests/support/test.db.js';
import { fakeCatalog, fakeContainer, fakeHandler, fakeSession, refusal, type FakeCall } from './chat.fakes.js';
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
    const setup = (steps: Parameters<typeof scriptedModel>[0], session: () => AuthenticationSession = () => fakeSession) => {
        const operationCalls: FakeCall[] = [];
        const catalog = fakeCatalog([
            fakeHandler('list_cards', true, operationCalls, { result: [{ id: '0007', stage: 'review' }] }),
            fakeHandler('move_card', false, operationCalls, { result: { id: '0007', stage: 'implementing' } }),
            fakeHandler('release_card', false, operationCalls, { fails: refusal('card 0007 holds no lease') }),
        ]);
        const actions = new ChatPendingActionRepository(db);
        const questions = new ChatQuestionRepository(db);
        const container = fakeContainer(actions, questions);
        const model = scriptedModel(steps);
        const service = new ChatService(
            container,
            new ConsoleLogger(),
            new ChatThreadRepository(db),
            new ChatMessageRepository(db),
            new ChatAttachmentRepository(db),
            actions,
            questions,
            new ChatUsageRepository(db),
            new GoalRepository(db),
            catalog,
            container.get(ProjectRepository),
            { api: new ApiChatEngine(model.registry), cli: undefined },
            async (): Promise<ChatEngineChoice> => ({ engine: 'api', provider: 'anthropic', model: 'claude-sonnet-5-5' }),
            session,
        );
        return { service, model, operationCalls, questions };
    };

    const proposeMove = calls('propose_change', {
        name: 'move_card',
        project: 'wilson',
        arguments: { id: '0007', body: { stage: 'implementing' } },
        summary: 'Move 0007 to implementing.',
    });

    describe('images', () => {
        const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
        const upload = async (thread: string, filename = 'a.png') =>
            (await new ChatAttachmentRepository(db).insert(thread, { filename, contentType: 'image/png', contentHash: 'hash', bytes: PNG })).id;
        const imagesIn = (prompts: unknown[]) =>
            (prompts.at(-1) as { role: string; content: { type: string }[] }[])
                .filter(message => message.role === 'user')
                .map(message => message.content.filter(part => part.type === 'file').length);

        it('sends images to the model, stores them on the message, and names an image-only thread', async () => {
            const { service, model } = setup([says('A red square.')]);
            const thread = await service.startThread();
            const id = await upload(thread.id);

            const result = await service.sendMessage(thread.id, { text: '', attachments: [id] });

            expect(imagesIn(model.prompts)).toEqual([1]);
            expect(result.message.attachments).toMatchObject([{ id, filename: 'a.png', contentType: 'image/png' }]);
            expect(result.reply.attachments).toBeUndefined();

            const detail = await service.getThread(thread.id);
            expect(detail.thread.title).toBe(IMAGE_THREAD_TITLE);
            expect(detail.messages.map(message => message.attachments?.length)).toEqual([1, undefined]);
        });

        it('refuses a message with neither text nor an image, and one with too many images', async () => {
            const { service } = setup([]);
            const thread = await service.startThread();

            await expect(service.sendMessage(thread.id, { text: '  ' })).rejects.toMatchObject({ statusCode: 400 });
            const ids = await Promise.all(Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => upload(thread.id)));
            await expect(service.sendMessage(thread.id, { text: 'hi', attachments: ids })).rejects.toMatchObject({ statusCode: 400 });
            expect((await service.getThread(thread.id)).messages).toEqual([]);
        });

        it("refuses an image already sent, another thread's, and an id no row could have", async () => {
            const { service } = setup([says('Seen.')]);
            const thread = await service.startThread();
            const other = await service.startThread();
            const id = await upload(thread.id);
            await service.sendMessage(thread.id, { text: 'one', attachments: [id] });

            await expect(service.sendMessage(thread.id, { text: 'again', attachments: [id] })).rejects.toMatchObject({ statusCode: 400 });
            await expect(service.sendMessage(thread.id, { text: 'theirs', attachments: [await upload(other.id)] })).rejects.toMatchObject({
                statusCode: 400,
            });
            await expect(service.sendMessage(thread.id, { text: 'junk', attachments: ['0x10'] })).rejects.toMatchObject({ statusCode: 400 });
            expect((await service.getThread(thread.id)).messages).toHaveLength(2);
        });

        it('resends the images of only the most recent messages that have any', async () => {
            const count = REPLAYED_IMAGE_MESSAGES + 1;
            const { service, model } = setup([...Array.from({ length: count }, () => says('Seen.')), says('Still here.')]);
            const thread = await service.startThread();
            for (let i = 0; i < count; i++) await service.sendMessage(thread.id, { text: `image ${i}`, attachments: [await upload(thread.id)] });

            await service.sendMessage(thread.id, { text: 'and now?' });

            expect(imagesIn(model.prompts)).toEqual([0, 1, 1, 1, 0]);
            const oldest = (model.prompts.at(-1) as { role: string; content: { type: string; text?: string }[] }[]).find(
                message => message.role === 'user',
            )!;
            expect(oldest.content[0]).toMatchObject({ text: '[An earlier image was attached here.]' });
        });
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

    it('takes the follow-ups off the stored answer, and offers them with it', async () => {
        const { service } = setup([says('One card: 0007.\n\n<suggestions>\n- Why is 0007 stuck?\n</suggestions>')]);
        const thread = await service.startThread();

        const turn = await service.sendMessage(thread.id, { text: 'What is in review?' });

        expect(turn.reply).toMatchObject({ content: 'One card: 0007.', suggestions: ['Why is 0007 stuck?'] });
    });

    it('offers no follow-ups while a change waits on the person', async () => {
        const { service } = setup([
            calls('propose_change', { name: 'move_card', project: 'wilson', arguments: { id: '0007' }, summary: 'Move 0007.' }),
            says('Proposed.\n<suggestions>\n- Then what?\n</suggestions>'),
        ]);
        const thread = await service.startThread();

        const turn = await service.sendMessage(thread.id, { text: 'Move 0007' });

        expect(turn.reply).toMatchObject({ content: 'Proposed.' });
        expect(turn.reply.suggestions).toBeUndefined();
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

    describe('usage', () => {
        const usageOf = (threadId: string) =>
            db
                .selectFrom('wilson.chatTurnUsage')
                .select(['engine', 'model', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'account'])
                .where('threadId', '=', BigInt(threadId))
                .orderBy('id')
                .execute();
        // The `api` engine signs in with no engine account, so its turns name none.
        const oneTurn = { engine: 'api', model: 'claude-sonnet-5-5', inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, account: undefined };

        it('records what a turn cost', async () => {
            const { service } = setup([says('Two cards.')]);
            const thread = await service.startThread();

            await service.sendMessage(thread.id, { text: 'What is in review?' });

            expect(await usageOf(thread.id)).toEqual([oneTurn]);
        });

        it(`records a silent follow-up too, which stores no message (${NOTHING_MORE})`, async () => {
            const { service } = setup([proposeMove, says('Proposed.'), says(NOTHING_MORE)]);
            const thread = await service.startThread();
            const { proposed } = await service.sendMessage(thread.id, { text: 'Move 0007' });

            await service.decide(proposed[0]!.id, { decision: 'confirm' });
            await service.whenIdle();

            expect((await service.getThread(thread.id)).messages).toHaveLength(2);
            expect(await usageOf(thread.id)).toEqual([{ ...oneTurn, inputTokens: 20, outputTokens: 10 }, oneTurn]);
        });

        it('records the account a turn names', async () => {
            const { service } = setup([says('Two cards.')]);
            const thread = await service.startThread();

            await new ChatUsageRepository(db).record(thread.id, {
                engine: 'cli',
                model: 'claude-sonnet-5-5',
                usage: { inputTokens: 1, outputTokens: 2 },
                account: 'pool-a',
            });

            expect(await usageOf(thread.id)).toEqual([expect.objectContaining({ engine: 'cli', account: 'pool-a' })]);
        });

        it('keeps the answer when its usage cannot be recorded', async () => {
            const record = vi.spyOn(ChatUsageRepository.prototype, 'record').mockRejectedValueOnce(new Error('the disk is full'));
            const { service } = setup([says('Two cards.')]);
            const thread = await service.startThread();

            const { reply } = await service.sendMessage(thread.id, { text: 'What is in review?' });

            expect(reply.content).toBe('Two cards.');
            record.mockRestore();
        });
    });

    it('does not propose the same change twice while the first still waits', async () => {
        const { service } = setup([proposeMove, says('Proposed.'), proposeMove, says('Already proposed.')]);
        const thread = await service.startThread();

        const first = await service.sendMessage(thread.id, { text: 'Move 0007' });
        const second = await service.sendMessage(thread.id, { text: 'Move 0007 please' });

        expect(first.proposed).toHaveLength(1);
        expect(second.proposed).toEqual([]);
        expect((await service.getThread(thread.id)).actions).toHaveLength(1);
    });

    describe('runNote', () => {
        const noRequest = () => {
            throw new Error('there is no request in progress');
        };
        const readCards = calls('dispatch_readonly', { name: 'list_cards', project: 'wilson' });

        it('runs where there is no request, and stores the answer but not the note', async () => {
            const { service, model, operationCalls } = setup([readCards, says('0007 is stuck.')], noRequest);
            const thread = await service.startThread();

            const outcome = await service.runNote(thread.id, '(A note from Wilson.) 0007 was flagged.', fakeSession, 'wilson');

            expect(outcome?.reply?.content).toBe('0007 is stuck.');
            expect(operationCalls.map(call => call.name)).toEqual(['list_cards']);
            expect(JSON.stringify(model.prompts[0])).toContain('0007 was flagged');
            const { messages } = await service.getThread(thread.id);
            expect(messages.map(message => [message.role, message.content])).toEqual([['assistant', '0007 is stuck.']]);
        });

        it(`stores nothing when there is nothing to say (${NOTHING_MORE})`, async () => {
            const { service } = setup([says(NOTHING_MORE)], noRequest);
            const thread = await service.startThread();

            const outcome = await service.runNote(thread.id, '(A note from Wilson.) 0007 passed.', fakeSession);

            expect(outcome).toEqual({ proposed: [], asked: [] });
            expect((await service.getThread(thread.id)).messages).toEqual([]);
        });

        it('hands back what it proposed, which still waits on the person', async () => {
            const { service, operationCalls } = setup([proposeMove, says('Proposed.')], noRequest);
            const thread = await service.startThread();

            const outcome = await service.runNote(thread.id, '(A note from Wilson.) 0007 was flagged.', fakeSession);

            expect(outcome?.proposed.map(action => action.status)).toEqual(['pending']);
            expect(operationCalls).toEqual([]);
        });

        it('rejects when the turn fails, where a follow-up would only log it', async () => {
            const { service } = setup([], noRequest);
            const thread = await service.startThread();

            await expect(service.runNote(thread.id, 'a note', fakeSession)).rejects.toMatchObject({ statusCode: 503 });
            await service.whenIdle();
        });

        it('answers undefined for a thread that does not exist', async () => {
            const { service, model } = setup([], noRequest);

            await expect(service.runNote('999999999', 'a note', fakeSession)).resolves.toBeUndefined();
            expect(model.prompts).toEqual([]);
        });

        it('takes turns with a message sent to the same thread', async () => {
            const { service, model } = setup([says('First.'), says('Second.')]);
            const thread = await service.startThread();

            const [sent, note] = await Promise.all([
                service.sendMessage(thread.id, { text: 'First?' }),
                service.runNote(thread.id, 'a note', fakeSession),
            ]);

            // Whichever takes the lock first, the other's turn reads its answer rather than racing it.
            expect([sent.reply.content, note?.reply?.content].sort()).toEqual(['First.', 'Second.']);
            expect(JSON.stringify(model.prompts[1])).toContain('First.');
        });
    });

    it('holds every turn to its own tools, so an engine that offers or runs another fails it', async () => {
        const turn = vi.spyOn(ApiChatEngine.prototype, 'turn');
        const { service } = setup([says('Two cards.')]);
        const thread = await service.startThread();

        await service.sendMessage(thread.id, { text: 'What is in review?' });

        expect(turn.mock.calls.map(([input]) => input.onlyOwnTools)).toEqual(['ran']);
        turn.mockRestore();
    });

    it("tells the model its thread's goal, and leaves its cards to be read", async () => {
        const project = `chat-goal-${randomUUID()}`;
        await db.insertInto('wilson.projects').values({ name: project, codeRoot: '/c', worktreeRoot: '/w', runRoot: '/r' }).execute();
        const { service, model } = setup([says('Noted.')]);
        const thread = await service.startThread();
        const goal = await new GoalRepository(db).create({ threadId: thread.id, project, title: 'Add SSO', outcome: 'People sign in with SSO' });

        await service.sendMessage(thread.id, { text: 'Where are we?' });

        const prompt = JSON.stringify(model.prompts[0]);
        expect(prompt).toContain(`sees through goal ${goal.id}`);
        expect(prompt).toContain('People sign in with SSO');
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

        expect(statusOf(failure)).toBe(503);
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

    describe('ask_user', () => {
        const oneQuestion = {
            header: 'Database',
            text: 'Which database should this project use?',
            options: [
                { label: 'Postgres', description: 'The default for this repo.' },
                { label: 'SQLite', description: 'Simpler, file-based.' },
            ],
            multiSelect: false,
        };
        const asksDatabase = calls('ask_user', { questions: [oneQuestion] });

        it('asks a question, shows it on the turn and the thread, and stores no suggestions even when offered', async () => {
            const { service } = setup([asksDatabase, says('Which database?\n<suggestions>\n- Something else?\n</suggestions>')]);
            const thread = await service.startThread();

            const turn = await service.sendMessage(thread.id, { text: 'Set up the project' });

            expect(turn.asked).toEqual([expect.objectContaining({ threadId: thread.id, questions: [oneQuestion], status: 'pending' })]);
            expect(turn.reply.suggestions).toBeUndefined();
            expect((await service.getThread(thread.id)).questions).toEqual(turn.asked);
        });

        it("streams a turn that asks a question: each question asked, in `proposed`'s own position, then done", async () => {
            const { service } = setup([asksDatabase, says('Asked.')]);
            const thread = await service.startThread();
            const heard: ChatStreamEvent[] = [];
            const stop = onChatEvent(thread.id, event => heard.push(event));

            const turn = await service.sendMessage(thread.id, { text: 'Set up the project' });
            stop();

            expect(heard.map(event => event.event)).toEqual(['asked', 'delta', 'done']);
            expect(heard[0]).toMatchObject({ event: 'asked', data: { id: turn.asked[0]!.id } });
        });

        it('refuses a bad submission, an unknown question, one from another thread, a second submission, and an expired one', async () => {
            const { service, questions } = setup([asksDatabase, says('Asked.')]);
            const thread = await service.startThread();
            const { asked } = await service.sendMessage(thread.id, { text: 'Set up the project' });
            const questionId = asked[0]!.id;

            expect(statusOf(await service.answerQuestions(thread.id, questionId, { answers: [{ chosen: [9] }] }).catch(err => err))).toBe(400);
            expect(statusOf(await service.answerQuestions(thread.id, '999999999', { answers: [{ chosen: [0] }] }).catch(err => err))).toBe(404);

            const otherThread = await service.startThread();
            expect(statusOf(await service.answerQuestions(otherThread.id, questionId, { answers: [{ chosen: [0] }] }).catch(err => err))).toBe(404);

            expect(await service.answerQuestions(thread.id, questionId, { answers: [{ chosen: [0] }] })).toMatchObject({ status: 'answered' });
            expect(statusOf(await service.answerQuestions(thread.id, questionId, { answers: [{ chosen: [0] }] }).catch(err => err))).toBe(409);

            const expired = await questions.ask(thread.id, { questions: [oneQuestion], expiresIn: Duration.fromObject({ seconds: -1 }) });
            expect(statusOf(await service.answerQuestions(thread.id, expired.id, { answers: [{ chosen: [0] }] }).catch(err => err))).toBe(409);
            await service.whenIdle();
        });

        it("starts a follow-up carrying what was chosen, and writes no message in the person's name", async () => {
            const { service, model } = setup([asksDatabase, says('Asked.'), says('Postgres it is. Setting it up.')]);
            const thread = await service.startThread();
            const { asked } = await service.sendMessage(thread.id, { text: 'Set up the project' });

            await service.answerQuestions(thread.id, asked[0]!.id, { answers: [{ chosen: [0], other: 'with replicas' }] });
            await service.whenIdle();

            const note = JSON.stringify(model.prompts[2]);
            expect(note).toContain('not from the person');
            expect(note).toContain('Postgres');
            expect(note).toContain('with replicas');
            const detail = await service.getThread(thread.id);
            expect(detail.messages.filter(message => message.role === 'user')).toHaveLength(1);
            expect(detail.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Postgres it is. Setting it up.' });
        });

        it('dismisses a pending question before answering a new message, and still answers it normally', async () => {
            const { service } = setup([asksDatabase, says('Asked.'), says('Sure, noted.')]);
            const thread = await service.startThread();
            const { asked } = await service.sendMessage(thread.id, { text: 'Set up the project' });

            const turn = await service.sendMessage(thread.id, { text: 'Actually, just use Postgres.' });

            expect(turn.reply).toMatchObject({ role: 'assistant', content: 'Sure, noted.' });
            expect((await service.getThread(thread.id)).questions).toEqual([expect.objectContaining({ id: asked[0]!.id, status: 'dismissed' })]);
        });
    });
});

/**
 * Confirming a proposed app over the real apps table, with the sign-in check faked. The real check is
 * in `chat.app.proposal.routes.test.ts`.
 */
describe('ChatService, confirming a proposed app', () => {
    const SLUG = `open-cards-${randomUUID().slice(0, 8)}`;
    const PROPOSED = { slug: SLUG, name: 'Open cards', description: 'What is open', html: '<h1>open</h1>', requestedGrants: ['stats.read'] };

    afterAll(async () => {
        await db.deleteFrom('wilson.apps').where('slug', '=', SLUG).execute();
    });

    const setup = (assert: () => Promise<void> = async () => {}) => {
        const operationCalls: FakeCall[] = [];
        const actions = new ChatPendingActionRepository(db);
        const questions = new ChatQuestionRepository(db);
        const apps = new AppsService(new AppsRepository(db));
        const container = fakeContainer(actions, questions, registry => {
            registry.register(PolicyService).useValue({ assert } as unknown as PolicyService);
            registry.register(AppsService).useValue(apps);
        });
        const model = scriptedModel([says(NOTHING_MORE), says(NOTHING_MORE)]);
        const threads = new ChatThreadRepository(db);
        const service = new ChatService(
            container,
            new ConsoleLogger(),
            threads,
            new ChatMessageRepository(db),
            new ChatAttachmentRepository(db),
            actions,
            questions,
            new ChatUsageRepository(db),
            new GoalRepository(db),
            fakeCatalog([fakeHandler('move_card', false, operationCalls, { result: { id: '0007' } })]),
            container.get(ProjectRepository),
            { api: new ApiChatEngine(model.registry), cli: undefined },
            async (): Promise<ChatEngineChoice> => ({ engine: 'api', provider: 'anthropic', model: 'claude-sonnet-5-5' }),
            () => fakeSession,
        );
        const propose = async () => {
            const thread = await service.startThread();
            return actions.propose(thread.id, {
                operation: PROPOSED_APP_OPERATION,
                arguments: PROPOSED,
                summary: 'Install Open cards.',
                expiresIn: Duration.fromObject({ minutes: 10 }),
            });
        };
        return { service, actions, apps, model, propose };
    };

    afterEach(async () => {
        await db.deleteFrom('wilson.apps').where('slug', '=', SLUG).execute();
    });

    it("installs it with the person's grants, not the ones the agent asked for", async () => {
        const { service, apps, propose } = setup();
        const action = await propose();

        const decided = await service.decide(action.id, { decision: 'confirm', grants: ['board.read'] });
        await service.whenIdle();

        expect(decided).toMatchObject({ status: 'done', result: { slug: SLUG, grants: ['board.read'] } });
        expect(await apps.get(SLUG)).toMatchObject({
            name: 'Open cards',
            description: 'What is open',
            html: '<h1>open</h1>',
            grants: ['board.read'],
        });
    });

    it('installs it with nothing granted when the person ticked nothing', async () => {
        const { service, apps, propose } = setup();

        await service.decide((await propose()).id, { decision: 'confirm', grants: [] });
        await service.whenIdle();

        expect((await apps.get(SLUG)).grants).toEqual([]);
    });

    it('keeps the HTML out of the stored result, which the model is told', async () => {
        const { service, actions, propose } = setup();
        const action = await propose();

        await service.decide(action.id, { decision: 'confirm', grants: [] });
        await service.whenIdle();

        expect(JSON.stringify((await actions.get(action.id))!.result)).not.toContain('<h1>');
    });

    it('refuses a confirm without grants and leaves the action waiting', async () => {
        const { service, actions, propose } = setup();
        const action = await propose();

        const refused = await service.decide(action.id, { decision: 'confirm' }).catch(err => err);

        expect(statusOf(refused)).toBe(400);
        expect(reasonOf(refused)).toContain('web app');
        expect((await actions.get(action.id))!.status).toBe('pending');
    });

    it('leaves the action waiting when the sign-in check refuses, and installs once it passes', async () => {
        let proved = false;
        const denied = Object.assign(new Error('Forbidden'), { statusCode: 403 });
        const { service, actions, apps, propose } = setup(async () => {
            if (!proved) throw denied;
        });
        const action = await propose();

        await expect(service.decide(action.id, { decision: 'confirm', grants: ['board.read'] })).rejects.toBe(denied);
        expect((await actions.get(action.id))!.status).toBe('pending');

        proved = true;
        expect(await service.decide(action.id, { decision: 'confirm', grants: ['board.read'] })).toMatchObject({ status: 'done' });
        await service.whenIdle();
        expect((await apps.get(SLUG)).grants).toEqual(['board.read']);
    });

    it('fails rather than replaces when the slug was taken meanwhile', async () => {
        const { service, apps, propose } = setup();
        await apps.install(SLUG, { name: 'Already here', html: '<h1>first</h1>', grants: ['stats.read'] });

        const decided = await service.decide((await propose()).id, { decision: 'confirm', grants: ['board.read'] });
        await service.whenIdle();

        expect(decided).toMatchObject({ status: 'failed', error: `an app named "${SLUG}" is already installed` });
        expect(await apps.get(SLUG)).toMatchObject({ name: 'Already here', html: '<h1>first</h1>', grants: ['stats.read'] });
    });

    it('lets a decline through with no grants and no sign-in check', async () => {
        const { service, apps, propose } = setup(async () => {
            throw new Error('must not be asked');
        });

        expect(await service.decide((await propose()).id, { decision: 'decline' })).toMatchObject({ status: 'declined' });
        expect(statusOf(await apps.get(SLUG).catch(err => err))).toBe(404);
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
