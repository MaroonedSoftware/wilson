import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { ServerKitContext } from '@maroonedsoftware/koa';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { ChatTurnInput, ChatTurnOutput } from '#modules/chat/chat.engine.js';
import type { CliChatEngine } from '#modules/chat/cli.chat.engine.js';
import type { CodeReadRepository } from '#modules/code/code.read.repository.js';
import type { DB } from '#modules/data/db.js';
import type { LearningsStore } from '#modules/learnings/learnings.store.js';
import { onReviewEvent, type ReviewStreamEvent } from '#modules/review/review.feed.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { EventLog } from '#modules/events/event.log.js';
import { DiffSource, type DiffResult } from '#modules/review/review.diff.source.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { ReviewService } from '#modules/review/review.service.js';
import type { DiffFileEntry } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { fakeSession } from '../chat/chat.fakes.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const PATCH = ['@@ -1,3 +1,3 @@', ' first', '-gone', '+added', ' third', ''].join('\n');
const fileWith = (patch: string): DiffFileEntry => ({ path: 'a.ts', status: 'modified', patch, truncated: false });

/** A branch the test moves by hand, so a review's relationship to its head is the thing under test. */
class FakeDiffSource extends DiffSource {
    current: DiffResult = { ok: true, head: 'sha-1', base: 'base-1', files: [fileWith(PATCH)], truncated: false };

    async head(): Promise<string | undefined> {
        return this.current.ok ? this.current.head : undefined;
    }

    async read(): Promise<DiffResult> {
        return this.current;
    }

    moveTo(head: string, patch = PATCH): void {
        this.current = { ok: true, head, base: 'base-1', files: [fileWith(patch)], truncated: false };
    }
}

/** Records what a turn was handed, and answers as it is told to. */
class FakeEngine {
    inputs: ChatTurnInput[] = [];
    answer: (input: ChatTurnInput) => Promise<ChatTurnOutput> = async input => {
        input.onText?.('streamed');
        return { text: 'the answer', engineSessionId: 'session-1', usage: { outputTokens: 7 } };
    };

    async turn(input: ChatTurnInput): Promise<ChatTurnOutput> {
        this.inputs.push(input);
        return this.answer(input);
    }
}

const card = (id: string, stage = 'ready'): Card => ({
    frontmatter: { id, title: `card ${id}`, stage, dependsOn: [], retries: {} },
    sections: {},
    body: 'body text',
});

const STAGES = [
    'stages:',
    '  - name: implementing',
    '    mode: agent',
    '    model: claude-opus',
    '    instructions: build it',
    '    onPass: ready',
    '    onFail: implementing',
    '  - name: ready',
    '    mode: manual',
    '    instructions: human review',
    '    onPass: merged',
    '    onFail: implementing',
    '',
].join('\n');

const fresh = async (stage = 'ready', stages = STAGES) => {
    const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
    const events = { append: vi.fn(async () => {}) };
    const board = new PostgresBoardRepository(config, db, { append: vi.fn(async () => {}) } as unknown as EventLog);
    await board.create(card('0001', stage), 'seed');
    const diffs = new FakeDiffSource();
    const writes = new BoardWriteService(
        board,
        config,
        {} as never,
        { append: vi.fn(async () => {}) } as unknown as EventLog,
        { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        new StaticStageConfigStore(stages),
    );
    const engine = new FakeEngine();
    const reads = { record: vi.fn(async () => {}) };
    const settings = { get: vi.fn(async () => ({ engine: 'cli', provider: 'anthropic', model: 'claude-sonnet-5-5' })) };
    const context = { authenticationSession: fakeSession } as unknown as ServerKitContext;
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
    const service = new ReviewService(
        board,
        config,
        diffs,
        db,
        writes,
        events as unknown as EventLog,
        engine as unknown as CliChatEngine,
        settings as unknown as SettingsStore,
        { load: async () => 'always test' } as unknown as LearningsStore,
        reads as unknown as CodeReadRepository,
        context,
        logger as never,
        new StaticStageConfigStore(stages),
    );
    return { board, config, diffs, events, engine, reads, settings, service };
};

const onAdded = { head: 'sha-1', file: 'a.ts', side: 'new' as const, line: 2, text: 'not like this' };

describe('ReviewService', () => {
    describe('state', () => {
        it('answers a card nobody has reviewed with no review and no comments, in any stage', async () => {
            const { service } = await fresh('implementing');

            await expect(service.state('0001')).resolves.toEqual({ review: undefined, comments: [] });
        });

        it('answers a missing card with a 404', async () => {
            const { service } = await fresh();

            await expect(service.state('9999')).rejects.toMatchObject({ statusCode: 404 });
        });
    });

    describe('open', () => {
        it('binds a new review to the current head', async () => {
            const { service } = await fresh();

            const { review } = await service.open('0001');

            expect(review).toMatchObject({ head: 'sha-1', base: 'base-1', status: 'open', stale: false });
        });

        it('rejoins the same review at the same head', async () => {
            const { service } = await fresh();

            const first = await service.open('0001');
            const second = await service.open('0001');

            expect(second.review!.id).toBe(first.review!.id);
        });

        it('reads as stale once the branch moves, then retires for a new review when reopened', async () => {
            const { diffs, service } = await fresh();
            const first = await service.open('0001');

            diffs.moveTo('sha-2');
            const seen = await service.state('0001');
            const reopened = await service.open('0001');

            expect(seen.review).toMatchObject({ id: first.review!.id, stale: true });
            expect(reopened.review).toMatchObject({ head: 'sha-2', status: 'open', stale: false });
            expect(reopened.review!.id).not.toBe(first.review!.id);
        });

        it('leaves one open review when two people open at once', async () => {
            const { service } = await fresh();

            const [one, two] = await Promise.all([service.open('0001'), service.open('0001')]);

            expect(one.review!.id).toBe(two.review!.id);
        });

        it('refuses a card outside ready, and a card with no branch', async () => {
            const notReady = await fresh('implementing');
            await expect(notReady.service.open('0001')).rejects.toMatchObject({ statusCode: 400 });

            const noBranch = await fresh();
            noBranch.diffs.current = { ok: false, reason: 'card/0001 has no branch yet' };
            await expect(noBranch.service.open('0001')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: 'card/0001 has no branch yet' },
            });
        });
    });

    describe('addComment', () => {
        it('stores the anchor from the diff and defaults to a blocker', async () => {
            const { service } = await fresh();

            const comment = await service.addComment('0001', onAdded);
            const { comments, review } = await service.state('0001');

            expect(comment).toMatchObject({
                lineText: 'added',
                severity: 'blocker',
                status: 'open',
                location: 'found',
                currentLine: 2,
                head: 'sha-1',
            });
            expect(comments).toEqual([comment]);
            expect(review!.id).toBe(comment.reviewId);
        });

        it('accepts a comment on a removed line', async () => {
            const { service } = await fresh();

            const comment = await service.addComment('0001', { ...onAdded, side: 'old', line: 2 });

            expect(comment).toMatchObject({ side: 'old', lineText: 'gone', location: 'found', currentLine: 2 });
        });

        it('answers a moved branch with a 409', async () => {
            const { diffs, service } = await fresh();
            diffs.moveTo('sha-2');

            await expect(service.addComment('0001', onAdded)).rejects.toMatchObject({ statusCode: 409 });
        });

        it('refuses a line the diff does not show, empty text, and a card outside ready', async () => {
            const { service } = await fresh();
            await expect(service.addComment('0001', { ...onAdded, line: 99 })).rejects.toMatchObject({ statusCode: 400 });
            await expect(service.addComment('0001', { ...onAdded, text: '   ' })).rejects.toMatchObject({ statusCode: 400 });

            const notReady = await fresh('implementing');
            await expect(notReady.service.addComment('0001', onAdded)).rejects.toMatchObject({ statusCode: 400 });
        });

        it('carries comments over to a new head, located against it', async () => {
            const { diffs, service } = await fresh();
            await service.addComment('0001', onAdded);
            await service.addComment('0001', { ...onAdded, line: 3, text: 'about the third' });

            diffs.moveTo('sha-2', ['@@ -5,2 +5,2 @@', ' other', '+added', ''].join('\n'));
            const { comments } = await service.open('0001');

            expect(comments.map(comment => [comment.location, comment.currentLine])).toEqual([
                ['found', 6],
                ['outdated', undefined],
            ]);
        });
    });

    describe('resolveComment', () => {
        it('moves a comment to resolved and keeps it on record', async () => {
            const { service } = await fresh();
            const comment = await service.addComment('0001', onAdded);

            const resolved = await service.resolveComment('0001', comment.id);

            expect(resolved.status).toBe('resolved');
            expect((await service.state('0001')).comments.map(stored => stored.status)).toEqual(['resolved']);
        });

        it("answers a comment that is not this card's, or not a number, with a 404", async () => {
            const { service } = await fresh();

            await expect(service.resolveComment('0001', '999999999')).rejects.toMatchObject({ statusCode: 404 });
            await expect(service.resolveComment('0001', 'abc')).rejects.toMatchObject({ statusCode: 404 });
        });
    });

    describe('requestChanges', () => {
        const pin = async (board: PostgresBoardRepository) => {
            const version = (await board.versions('0001', 1))[0]!.id;
            await board.write('0001', 'pin', current => ({ ...current, frontmatter: { ...current.frontmatter, planVersionId: version } }));
            return version;
        };

        it('sends open comments to the pinned plan, moves the card, and marks them sent', async () => {
            const { board, service } = await fresh();
            const pinned = await pin(board);
            await service.addComment('0001', onAdded);
            await service.addComment('0001', { ...onAdded, side: 'old', line: 2, severity: 'concern', text: 'why was this removed' });

            const { review, comments } = await service.requestChanges('0001', { head: 'sha-1' });

            const stored = await board.read('0001');
            const plan = (await board.readAt('0001', stored.frontmatter.planVersionId!)).body;
            expect(stored.frontmatter.stage).toBe('implementing');
            expect(stored.frontmatter.planVersionId).not.toBe(pinned);
            expect(plan).toContain('not like this');
            expect(plan).toContain('On line 2: `added`');
            expect(plan).toContain('why was this removed');
            expect(plan).toContain('On removed line 2: `gone`');
            expect(comments.map(comment => comment.status)).toEqual(['sent', 'sent']);
            expect(review).toMatchObject({ status: 'changes_requested', verdictAt: expect.anything() });
        });

        it('leaves out resolved comments, and comments already sent in an earlier round', async () => {
            const { board, diffs, service } = await fresh();
            const resolved = await service.addComment('0001', { ...onAdded, text: 'never mind' });
            await service.resolveComment('0001', resolved.id);
            await service.addComment('0001', { ...onAdded, text: 'round one' });
            await service.requestChanges('0001', { head: 'sha-1' });

            await board.write('0001', 'back to ready', current => ({ ...current, frontmatter: { ...current.frontmatter, stage: 'ready' } }));
            diffs.moveTo('sha-2');
            await service.addComment('0001', { ...onAdded, head: 'sha-2', text: 'round two' });
            await service.requestChanges('0001', { head: 'sha-2' });

            const { body } = await board.read('0001');
            expect(body).toContain('round two');
            expect(body).not.toContain('round one');
            expect(body).not.toContain('never mind');
        });

        it('sends an outdated comment at the line it was written on', async () => {
            const { board, diffs, service } = await fresh();
            await service.addComment('0001', onAdded);
            diffs.moveTo('sha-2', ['@@ -1 +1 @@', '+something else', ''].join('\n'));

            await service.requestChanges('0001', { head: 'sha-2' });

            expect((await board.read('0001')).body).toContain('On line 2: `added`');
        });

        it('refuses a moved branch, no open comments, and a card outside ready, changing nothing', async () => {
            const { board, diffs, service } = await fresh();
            await expect(service.requestChanges('0001', { head: 'sha-1' })).rejects.toMatchObject({ statusCode: 400 });

            await service.addComment('0001', onAdded);
            diffs.moveTo('sha-2');
            await expect(service.requestChanges('0001', { head: 'sha-1' })).rejects.toMatchObject({ statusCode: 409 });
            expect((await board.read('0001')).frontmatter.stage).toBe('ready');
            expect((await service.state('0001')).comments.map(comment => comment.status)).toEqual(['open']);

            const notReady = await fresh('implementing');
            await expect(notReady.service.requestChanges('0001', { head: 'sha-1' })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('answers a missing ready stage with a 400 naming the project, and leaves comments open', async () => {
            const noReady = [
                'stages:',
                '  - name: implementing',
                '    mode: agent',
                '    model: claude-opus',
                '    instructions: x',
                '    onPass: merged',
                '    onFail: implementing',
                '',
            ];
            const { service } = await fresh('ready', noReady.join('\n'));
            await service.addComment('0001', onAdded);

            await expect(service.requestChanges('0001', { head: 'sha-1' })).rejects.toMatchObject({ statusCode: 400 });
            expect((await service.state('0001')).comments.map(comment => comment.status)).toEqual(['open']);
        });
    });

    describe('approve', () => {
        it('records the verdict and an event naming the commit, and leaves the card in ready', async () => {
            const { board, events, service } = await fresh();
            await service.open('0001');

            const { review } = await service.approve('0001', { head: 'sha-1' });

            expect(review).toMatchObject({ status: 'approved', head: 'sha-1', verdictAt: expect.anything() });
            expect((await board.read('0001')).frontmatter.stage).toBe('ready');
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({ cardId: '0001', type: 'review.approved', payload: { head: 'sha-1' } }),
            );
        });

        it('is refused by an open blocker, then allowed once it is resolved', async () => {
            const { events, service } = await fresh();
            const blocker = await service.addComment('0001', onAdded);

            await expect(service.approve('0001', { head: 'sha-1' })).rejects.toMatchObject({ statusCode: 400 });
            expect(events.append).not.toHaveBeenCalled();

            await service.resolveComment('0001', blocker.id);
            await expect(service.approve('0001', { head: 'sha-1' })).resolves.toMatchObject({ review: { status: 'approved' } });
        });

        it('is not refused by an open concern', async () => {
            const { service } = await fresh();
            await service.addComment('0001', { ...onAdded, severity: 'concern' });

            await expect(service.approve('0001', { head: 'sha-1' })).resolves.toMatchObject({ review: { status: 'approved' } });
        });

        it('answers a moved branch with a 409, and a card outside ready with a 400', async () => {
            const { diffs, service } = await fresh();
            diffs.moveTo('sha-2');
            await expect(service.approve('0001', { head: 'sha-1' })).rejects.toMatchObject({ statusCode: 409 });

            const notReady = await fresh('implementing');
            await expect(notReady.service.approve('0001', { head: 'sha-1' })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('stands when the review is reopened at the same commit, and goes stale when the branch moves', async () => {
            const { diffs, service } = await fresh();
            await service.approve('0001', { head: 'sha-1' });

            await expect(service.open('0001')).resolves.toMatchObject({ review: { status: 'approved', stale: false } });

            diffs.moveTo('sha-2');
            await expect(service.state('0001')).resolves.toMatchObject({ review: { status: 'approved', stale: true } });
            await expect(service.open('0001')).resolves.toMatchObject({ review: { status: 'open', head: 'sha-2' } });
        });

        it('starts a new open review when a comment follows an approval', async () => {
            const { service } = await fresh();
            const { review: approved } = await service.approve('0001', { head: 'sha-1' });

            const comment = await service.addComment('0001', onAdded);

            expect(comment.reviewId).not.toBe(approved!.id);
            await expect(service.state('0001')).resolves.toMatchObject({ review: { status: 'open' } });
        });
    });

    describe('sendTurn', () => {
        const ask = { head: 'sha-1', text: 'why this way?' };

        it('stores what was typed, not the context the engine was given', async () => {
            const { engine, service } = await fresh();
            await service.addComment('0001', onAdded);

            const answer = await service.sendTurn('0001', ask);

            expect(answer).toMatchObject({ role: 'assistant', content: 'the answer' });
            expect((await service.turns('0001')).map(turn => [turn.role, turn.content])).toEqual([
                ['user', 'why this way?'],
                ['assistant', 'the answer'],
            ]);
            const prompt = engine.inputs[0]!.text;
            expect(prompt).toContain('body text');
            expect(prompt).toContain('always test');
            expect(prompt).toContain('not like this');
            expect(prompt.endsWith('why this way?')).toBe(true);
        });

        it('reads the plan at its pin, not its newest text', async () => {
            const { board, engine, service } = await fresh();
            const version = (await board.versions('0001', 1))[0]!.id;
            await board.write('0001', 'pin and edit', current => ({
                ...current,
                body: 'edited since',
                frontmatter: { ...current.frontmatter, planVersionId: version },
            }));

            await service.sendTurn('0001', ask);

            expect(engine.inputs[0]!.text).toContain('body text');
            expect(engine.inputs[0]!.text).not.toContain('edited since');
        });

        it('resumes its session, and tells the agent about each comment once', async () => {
            const { engine, service } = await fresh();
            await service.addComment('0001', onAdded);
            await service.sendTurn('0001', ask);
            await service.sendTurn('0001', { ...ask, text: 'and now?' });
            await service.addComment('0001', { ...onAdded, text: 'another thought' });
            await service.sendTurn('0001', { ...ask, text: 'and this?' });

            const [, second, third] = engine.inputs;
            expect(second!.thread.engineSessionId).toBe('session-1');
            expect(second!.text).toBe('and now?');
            expect(third!.text).toContain('another thought');
            expect(third!.text).not.toContain('not like this');
        });

        it('gives the agent nothing that writes to the project, and asks the engine to hold it to that', async () => {
            const { engine, service } = await fresh();

            await service.sendTurn('0001', ask);

            const [input] = engine.inputs;
            expect(input!.tools.map(tool => tool.name).sort()).toEqual([
                'list_changed_files',
                'list_directory',
                'read_change',
                'read_file',
                'search_code',
                'set_tour',
            ]);
            expect(input!.onlyOwnTools).toBe(true);
            expect(input!.maxSteps).toBeGreaterThan(20);
        });

        it("keeps a denied file's contents from the agent, in its patch and in a comment on it", async () => {
            const { diffs, engine, service } = await fresh();
            diffs.current = {
                ok: true,
                head: 'sha-1',
                base: 'base-1',
                truncated: false,
                files: [{ path: '.env', status: 'modified', patch: '@@ -0,0 +1 @@\n+SECRET=1\n', truncated: false }],
            };
            await service.addComment('0001', { head: 'sha-1', file: '.env', side: 'new', line: 1, text: 'should this be here' });

            await service.sendTurn('0001', ask);

            expect(engine.inputs[0]!.text).toContain('should this be here');
            expect(engine.inputs[0]!.text).not.toContain('SECRET=1');
            const tools = engine.inputs[0]!.tools;
            const readChange = tools.find(tool => tool.name === 'read_change')!;
            expect(await readChange.execute({ path: '.env' })).toContain('deny list');
            expect(await tools.find(tool => tool.name === 'list_changed_files')!.execute({})).toContain('"denied":true');
        });

        it('keeps an approval through a question', async () => {
            const { service } = await fresh();
            await service.approve('0001', { head: 'sha-1' });

            await service.sendTurn('0001', ask);

            await expect(service.state('0001')).resolves.toMatchObject({ review: { status: 'approved' } });
        });

        it("uses the ready lane's model when it names one, over the chat engine's", async () => {
            const { engine, service } = await fresh(
                'ready',
                STAGES.replace('instructions: human review', 'model: claude-haiku\n    instructions: human review'),
            );

            await service.sendTurn('0001', ask);

            expect(engine.inputs[0]!.model).toBe('claude-haiku');
        });

        it('falls back to a default Claude model when the chat runs on another provider', async () => {
            const { engine, settings, service } = await fresh();
            settings.get.mockResolvedValue({ engine: 'api', provider: 'xai', model: 'grok-9' } as never);

            await service.sendTurn('0001', ask);

            expect(engine.inputs[0]!.model).toMatch(/^claude-/);
        });

        it('publishes the text as it is written, then done', async () => {
            const { config, service } = await fresh();
            const seen: ReviewStreamEvent[] = [];
            const stop = onReviewEvent(config.project, '0001', event => seen.push(event));

            const answer = await service.sendTurn('0001', ask);
            stop();

            expect(seen).toEqual([
                { event: 'delta', data: 'streamed' },
                { event: 'done', data: { seq: answer.seq } },
            ]);
        });

        it('answers a failed turn with a 503 and a failed event, keeping what the person typed', async () => {
            const { config, engine, service } = await fresh();
            engine.answer = async () => {
                throw new Error('the engine reached for a tool it was not given: Bash');
            };
            const seen: ReviewStreamEvent[] = [];
            const stop = onReviewEvent(config.project, '0001', event => seen.push(event));

            await expect(service.sendTurn('0001', ask)).rejects.toMatchObject({ statusCode: 503 });
            stop();

            expect(seen[0]).toMatchObject({ event: 'failed', data: { reason: expect.stringContaining('Bash') } });
            expect((await service.turns('0001')).map(turn => turn.role)).toEqual(['user']);
        });

        it('runs two messages sent at once one after the other', async () => {
            const { engine, service } = await fresh();
            let running = 0;
            let most = 0;
            engine.answer = async () => {
                most = Math.max(most, (running += 1));
                await new Promise(resolve => setTimeout(resolve, 20));
                running -= 1;
                return { text: 'done' };
            };

            await Promise.all([service.sendTurn('0001', ask), service.sendTurn('0001', { ...ask, text: 'another' })]);

            expect(most).toBe(1);
            expect((await service.turns('0001')).map(turn => turn.seq)).toEqual([1, 2, 3, 4]);
        });

        it('refuses empty text, a moved branch, and a card outside ready', async () => {
            const { diffs, service } = await fresh();
            await expect(service.sendTurn('0001', { ...ask, text: ' ' })).rejects.toMatchObject({ statusCode: 400 });

            diffs.moveTo('sha-2');
            await expect(service.sendTurn('0001', ask)).rejects.toMatchObject({ statusCode: 409 });

            const notReady = await fresh('implementing');
            await expect(notReady.service.sendTurn('0001', ask)).rejects.toMatchObject({ statusCode: 400 });
        });

        it('starts fresh on a new commit, reminding the agent what was already sent back', async () => {
            const { board, diffs, engine, service } = await fresh();
            await service.addComment('0001', { ...onAdded, text: 'round one' });
            await service.sendTurn('0001', ask);
            await service.requestChanges('0001', { head: 'sha-1' });
            await board.write('0001', 'back to ready', current => ({ ...current, frontmatter: { ...current.frontmatter, stage: 'ready' } }));
            diffs.moveTo('sha-2');

            await service.sendTurn('0001', { head: 'sha-2', text: 'better?' });

            const last = engine.inputs.at(-1)!;
            expect(last.thread.engineSessionId).toBeUndefined();
            expect(last.text).toContain('already sent these back');
            expect(last.text).toContain('round one');
            expect((await service.turns('0001')).map(turn => turn.content)).toEqual(['better?', 'the answer']);
        });

        describe('the tour', () => {
            const STEPS = {
                steps: [{ title: 'The change', explanation: 'What it does', anchors: [{ file: 'a.ts', side: 'new', startLine: 2, endLine: 2 }] }],
            };
            const publishing = (engine: FakeEngine) => {
                engine.answer = async input => {
                    await input.tools.find(tool => tool.name === 'set_tour')!.execute(STEPS);
                    return { text: 'published it' };
                };
            };

            it('asks for one only on a tour turn, and stores it on the review', async () => {
                const { engine, service } = await fresh();
                publishing(engine);

                await service.sendTurn('0001', { ...ask, mode: 'tour', text: 'Walk me through this' });

                expect(engine.inputs[0]!.text).toContain('publish it as ordered steps');
                expect((await service.turns('0001'))[0]!.content).toBe('Walk me through this');
                const { review } = await service.state('0001');
                expect(review!.tour).toEqual([
                    {
                        title: 'The change',
                        explanation: 'What it does',
                        anchors: [{ file: 'a.ts', side: 'new', startLine: 2, endLine: 2, status: 'in-diff' }],
                    },
                ]);
            });

            it('does not ask for one on an ordinary turn', async () => {
                const { engine, service } = await fresh();

                await service.sendTurn('0001', ask);

                expect(engine.inputs[0]!.text).not.toContain('publish it as ordered steps');
            });

            it('publishes the tour to whoever is watching as soon as it is written', async () => {
                const { config, engine, service } = await fresh();
                publishing(engine);
                const seen: ReviewStreamEvent[] = [];
                const stop = onReviewEvent(config.project, '0001', event => seen.push(event));

                await service.sendTurn('0001', { ...ask, mode: 'tour' });
                stop();

                expect(seen.map(event => event.event)).toEqual(['tour', 'done']);
            });

            it('tells the agent which step is on screen', async () => {
                const { engine, service } = await fresh();
                publishing(engine);
                await service.sendTurn('0001', { ...ask, mode: 'tour' });
                engine.answer = async () => ({ text: 'ok' });

                await service.sendTurn('0001', { ...ask, text: 'why this?', stepIndex: 0 });
                await service.sendTurn('0001', { ...ask, text: 'and that?', stepIndex: 9 });

                expect(engine.inputs[1]!.text).toContain('step 1 of your tour, "The change"');
                expect(engine.inputs[2]!.text).toBe('and that?');
            });

            it('leaves a new commit with no tour', async () => {
                const { diffs, engine, service } = await fresh();
                publishing(engine);
                await service.sendTurn('0001', { ...ask, mode: 'tour' });

                diffs.moveTo('sha-2');
                const { review } = await service.open('0001');

                expect(review!.tour).toBeUndefined();
            });
        });
    });
});
