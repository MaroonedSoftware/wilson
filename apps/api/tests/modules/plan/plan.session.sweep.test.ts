import { describe, expect, it, vi } from 'vitest';
import { currentProject } from '#modules/board/project.context.js';
import { PlanSessionSweep } from '#modules/plan/plan.session.sweep.js';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

describe('PlanSessionSweep', () => {
    it('sweeps every project, as that project', async () => {
        const seen: (string | undefined)[] = [];
        const plans = {
            closeFinished: vi.fn(async () => {
                seen.push(currentProject());
                return [];
            }),
        };
        const register = vi.fn();
        const projects = { list: async () => [{ name: 'one' }, { name: 'two' }] };

        await new PlanSessionSweep(plans as never, projects as never, { register } as never, logger() as never).run();

        expect(seen).toEqual(['one', 'two']);
        expect(register).toHaveBeenCalledTimes(2);
    });

    it('goes on to the next project when one fails, and never throws', async () => {
        const log = logger();
        const failure = new Error('no such repo');
        const closeFinished = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(['0003']);
        const projects = { list: async () => [{ name: 'broken' }, { name: 'fine' }] };

        await new PlanSessionSweep({ closeFinished } as never, projects as never, { register: vi.fn() } as never, log as never).run();

        expect(log.error).toHaveBeenCalledWith(failure);
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('fine'));
    });

    it('does not stop a start when the projects cannot be listed', async () => {
        const log = logger();
        const projects = { list: () => Promise.reject(new Error('no database')) };

        await expect(new PlanSessionSweep({} as never, projects as never, {} as never, log as never).run()).resolves.toBeUndefined();
        expect(log.error).toHaveBeenCalled();
    });
});
