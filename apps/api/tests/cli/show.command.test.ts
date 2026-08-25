import { describe, expect, it, vi } from 'vitest';
import { BoardRepository } from '#modules/board/board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { BoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';

// Same seam as `run.command.test.ts` and `approve.command.test.ts`: `show.command.ts` wraps its
// handler in johnny5's `requireContainer`, stubbed here to the identity function so the handler is
// directly callable with a fake `ctx`.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

const { default: command } = await import('../../../../packages/cli/src/commands/card/show.command.js');

type Handler = (opts: { json?: boolean }, ctx: unknown, args: unknown[]) => Promise<number | void>;

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

const card = (overrides: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id: '0001', title: 'do the thing', stage: 'backlog', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body: '## Goal\n\nDo it.\n',
});

const buildCtx = (fixture: Card) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const board = { read: vi.fn(async () => fixture) };
    const events = { tail: vi.fn(async () => []) };
    const config = { project: 'wilson' };
    const container = {
        get: (token: unknown) => {
            if (token === BoardRepository) return board;
            if (token === EventLog) return events;
            if (token === BoardConfig) return config;
            throw new Error(`buildCtx: unexpected token ${String(token)}`);
        },
    };
    return { ctx: { container, logger }, logger };
};

describe('wilson card show: the pinned-plan line', () => {
    it('reports the pinned version once a card has been approved', async () => {
        const { ctx, logger } = buildCtx(card({ planVersionId: '42' }));

        const result = await run(ctx, '0001');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('pinned:   42');
    });

    it('falls back to a message pointing at "wilson card approve", not the old "stages run against current state" wording, when a card has never been approved', async () => {
        const { ctx, logger } = buildCtx(card());

        await run(ctx, '0001');

        expect(logger.info).toHaveBeenCalledWith('pinned:   — (not approved; wilson card approve to pin the plan a stage runs against)');
        expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('stages run against current state'));
    });

    it('no longer prints the old "planVersion:" label', async () => {
        const { ctx, logger } = buildCtx(card({ planVersionId: '42' }));

        await run(ctx, '0001');

        const printed = logger.info.mock.calls.map(([msg]: [unknown]) => msg);
        expect(printed.some(msg => typeof msg === 'string' && msg.startsWith('planVersion:'))).toBe(false);
    });
});
