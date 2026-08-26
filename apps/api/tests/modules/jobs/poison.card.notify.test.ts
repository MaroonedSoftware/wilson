import { afterEach, describe, expect, it, vi } from 'vitest';
import { poisonCard } from '#modules/jobs/poison.card.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { Card, CardFrontmatter } from '#modules/board/card.js';

const card = (stage: string, title = 'do the thing'): Card => ({
    frontmatter: { id: '0001', title, stage, dependsOn: [], retries: {} } as CardFrontmatter,
    sections: {},
    body: '',
});

/**
 * Card 0050: `poisonCard` is shared between `CardStageJob.poison` (a stage's own failure classified
 * permanent) and `CardStageDeadJob` (a `card.stage` job that exhausted pg-boss's retries) — one
 * write, one notification, regardless of which noticed the poisoning. These exercise the notify
 * half directly against that shared function, standing in for a real webhook with a stubbed
 * `fetch`, rather than duplicating the same assertions once per caller.
 */
describe('poisonCard notifies (card 0050)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const boardWith = (notifyWebhookUrl?: string, notifyBaseUrl?: string): BoardConfig =>
        new StaticBoardConfig('test', '/tmp/board', '/tmp/code', '/tmp/worktrees', '/tmp/run', notifyWebhookUrl, notifyBaseUrl);

    // `write`'s mock invokes the real mutate callback, the way `PostgresBoardRepository.write` does,
    // so `poisonCard`'s title-capture and already-poisoned guard (both read off the card the mutate
    // callback receives) see real values instead of whatever a blind mock would leave untouched.
    const repoOver = (existing: Card) => ({
        write: vi.fn(async (_id: string, _msg: string, mutate: (c: Card) => Card | Promise<Card>) => {
            await mutate(existing);
            return 'sha';
        }),
    });

    const events = () => ({ append: vi.fn(async () => {}) }) as unknown as EventLog;

    it('posts a "poisoned" notification, carrying the card title and reason, when a webhook is configured', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const boardRepo = repoOver(card('implementing', 'a poisoned card'));
        const board = boardWith('https://hooks.example/notify', 'https://board.example');

        await poisonCard(
            { boardRepo: boardRepo as unknown as BoardRepository, events: events(), board },
            { project: 'test', cardId: '0001', stageName: 'implementing', reason: 'credit balance too low' },
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toMatchObject({
            moment: 'poisoned',
            project: 'test',
            cardId: '0001',
            title: 'a poisoned card',
            stage: 'implementing',
            reason: 'credit balance too low',
            url: 'https://board.example/cards/0001',
        });
    });

    it('makes no HTTP call when no webhook is configured', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const boardRepo = repoOver(card('implementing'));

        await poisonCard(
            { boardRepo: boardRepo as unknown as BoardRepository, events: events(), board: boardWith(undefined) },
            { project: 'test', cardId: '0001', stageName: 'implementing', reason: 'boom' },
        );

        expect(fetchMock).not.toHaveBeenCalled();
    });

    // Do not send twice for one event: a `card.stage.dead` retry, or a redelivered job, landing here
    // after an earlier attempt already poisoned the card has nothing new to report.
    it('does not notify when the card was already poisoned before this write started (a redelivery)', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const boardRepo = repoOver(card('poisoned'));

        await poisonCard(
            { boardRepo: boardRepo as unknown as BoardRepository, events: events(), board: boardWith('https://hooks.example/notify') },
            { project: 'test', cardId: '0001', stageName: 'implementing', reason: 'boom again' },
        );

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('notifies only after the board write has resolved, not before or inside it', async () => {
        const order: string[] = [];
        const fetchMock = vi.fn(async () => {
            order.push('notified');
            return new Response(null, { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        const boardRepo = {
            write: vi.fn(async (_id: string, _msg: string, mutate: (c: Card) => Card | Promise<Card>) => {
                await mutate(card('implementing'));
                order.push('written');
                return 'sha';
            }),
        };

        await poisonCard(
            { boardRepo: boardRepo as unknown as BoardRepository, events: events(), board: boardWith('https://hooks.example/notify') },
            { project: 'test', cardId: '0001', stageName: 'implementing', reason: 'boom' },
        );

        expect(order).toEqual(['written', 'notified']);
    });

    it('does not fail the poisoning when the webhook itself fails', async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        });
        vi.stubGlobal('fetch', fetchMock);
        const boardRepo = repoOver(card('implementing'));

        await expect(
            poisonCard(
                { boardRepo: boardRepo as unknown as BoardRepository, events: events(), board: boardWith('https://hooks.example/notify') },
                { project: 'test', cardId: '0001', stageName: 'implementing', reason: 'boom' },
            ),
        ).resolves.toBeUndefined();

        expect(boardRepo.write).toHaveBeenCalledTimes(1);
    });
});
