import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { HealthService } from '#modules/health/health.service.js';

// Card 0079 added `startedAt` to what `/api/health` reports, so `wilson doctor`'s "daemon not
// stale" check can ask the API when it came up instead of `pgrep`ing a process line. It has to be
// captured once, when the process boots, not computed per request — a live clock read would report
// "now" for a daemon that started hours ago, which is exactly the daemon a staleness check needs to
// catch.
const buildConfig = (project = 'wilson') => new StaticBoardConfig(project, '/board', '/code', '/worktrees', '/run');

describe('HealthService', () => {
    it('reports a valid startedAt alongside ok, project, and head', () => {
        const service = new HealthService(buildConfig('my-project'));

        const result = service.get();

        expect(result.ok).toBe(true);
        expect(result.project).toBe('my-project');
        expect(typeof result.head).toBe('string');
        expect(result.startedAt).toBeInstanceOf(DateTime);
        expect((result.startedAt as DateTime).isValid).toBe(true);
    });

    it('captures startedAt once at module load, not per call or per instance', async () => {
        const first = new HealthService(buildConfig()).get().startedAt as DateTime;

        // Give the wall clock a chance to move before asking again.
        await new Promise(resolve => setTimeout(resolve, 20));

        const second = new HealthService(buildConfig('a-different-project')).get().startedAt as DateTime;

        expect(second.toMillis()).toBe(first.toMillis());
    });
});
