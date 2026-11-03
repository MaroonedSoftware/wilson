import { describe, expect, it, vi } from 'vitest';
import { buildCtx, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

// `wilson stages route` lists routing, or changes one stage. Any option left out keeps the stage's
// current value, so the command always sends the whole routing the API asks for.
const { default: command } = await import('../../../../packages/cli/src/commands/stages/route.command.js');

type Opts = { adapter?: string; provider?: string; model?: string; message?: string };
const run = (ctx: unknown, args: string[] = [], opts: Opts = {}) => (command.run as unknown as Handler<Opts>)(opts, ctx, args);

const implementing = { stage: 'implementing', mode: 'agent', adapter: 'cli', provider: 'anthropic', model: 'claude-opus' };

describe('wilson stages route', () => {
    it('lists every stage with no arguments, and writes nothing', async () => {
        const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        fetchMock.mockResolvedValueOnce(jsonResponse([implementing]));
        const { ctx } = buildCtx();

        const result = await run(ctx);

        const printed = write.mock.calls.map(call => String(call[0])).join('');
        write.mockRestore();
        expect(result).toBe(0);
        expect(printed).toContain('implementing');
        expect(printed).toContain('claude-opus');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the current value of every option left out', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([implementing]));
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...implementing, model: 'claude-haiku' }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, ['implementing'], { model: 'claude-haiku' });

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/stages/routing/implementing');
        expect(methodOf(fetchMock.mock.calls[1]!)).toBe('PUT');
        const sent = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
        expect(sent).toEqual({ adapter: 'cli', provider: 'anthropic', model: 'claude-haiku' });
        expect(logger.info).toHaveBeenCalledWith('implementing now runs cli anthropic claude-haiku');
    });

    // With no terminal a prompt never settles and the process exits as though it had finished.
    it('reports why, rather than exiting silently, when a change needs a password and there is no terminal', async () => {
        const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        fetchMock.mockResolvedValueOnce(jsonResponse([implementing]));
        fetchMock.mockResolvedValueOnce(jsonResponse({ statusCode: 403, message: 'Forbidden', details: { kind: 'step_up_unavailable' } }, 403));
        fetchMock.mockResolvedValueOnce(jsonResponse({ email: 'operator@example.com' }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, ['implementing'], { model: 'claude-haiku' });

        if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('run it from a terminal'));
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('names the stages it has when asked for one it does not', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([implementing]));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, ['nope'], { model: 'x' });

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('no stage named "nope" (have: implementing)');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('warns when review shares a provider with implementing, but saves all the same', async () => {
        const routes = [
            { stage: 'implementing', mode: 'agent', adapter: 'cli', provider: 'anthropic', model: 'claude' },
            { stage: 'review', mode: 'agent', adapter: 'api', provider: 'openai', model: 'gpt-5' },
        ];
        fetchMock.mockResolvedValueOnce(jsonResponse(routes));
        fetchMock.mockResolvedValueOnce(jsonResponse(routes[1]));
        const { ctx, logger } = buildCtx();

        const result = await (command.run as unknown as Handler<{ adapter?: string; provider?: string }>)(
            { adapter: 'cli', provider: 'anthropic' },
            ctx,
            ['review'],
        );

        expect(result).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('review and implementing both run on anthropic'));
    });
});
