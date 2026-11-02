import { describe, expect, it } from 'vitest';
import { describeUsageLimit, UsageLimitWatch } from '#modules/agent/usage.limit.js';

const event = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' }) as never;

describe('UsageLimitWatch', () => {
    it('sees nothing in an ordinary run', () => {
        const watch = new UsageLimitWatch('pool-a');

        watch.observe(event({ status: 'allowed' }));
        watch.observe(event({ status: 'allowed_warning', utilization: 0.9 }));
        watch.observe({ type: 'assistant', message: { content: [] } } as never);

        expect(watch.limit).toBeUndefined();
    });

    it('takes the limit and its reset from a refusal, reading the reset as seconds', () => {
        const watch = new UsageLimitWatch('pool-a');

        watch.observe(event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_900_000_000 }));

        expect(watch.limit).toEqual({ account: 'pool-a', limitType: 'five_hour', resetsAt: 1_900_000_000_000 });
    });

    it('carries on past a refusal that overage is paying for', () => {
        const watch = new UsageLimitWatch('pool-a');

        watch.observe(event({ status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'allowed' }));

        expect(watch.limit).toBeUndefined();
    });

    it('forgets a refusal the engine later says is over', () => {
        const watch = new UsageLimitWatch('pool-a');

        watch.observe(event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_900_000_000 }));
        watch.observe(event({ status: 'allowed' }));

        expect(watch.limit).toBeUndefined();
    });

    it('keeps a known reset when the assistant error follows the event', () => {
        const watch = new UsageLimitWatch('pool-a');

        watch.observe(event({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1_900_000_000 }));
        watch.observe({ type: 'assistant', error: 'rate_limit', message: { content: [] } } as never);

        expect(watch.limit).toMatchObject({ limitType: 'seven_day', resetsAt: 1_900_000_000_000 });
    });

    it('waits a while when only an assistant error or the result text says so', () => {
        const before = Date.now();
        const assistant = new UsageLimitWatch('pool-a');
        const result = new UsageLimitWatch('pool-a');

        assistant.observe({ type: 'assistant', error: 'rate_limit', message: { content: [] } } as never);
        result.observe({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit" } as never);

        expect(assistant.limit?.limitType).toBe('unknown');
        expect(assistant.limit!.resetsAt).toBeGreaterThan(before);
        expect(result.limit?.limitType).toBe('unknown');
    });

    it('does not read a limit into an ordinary result that mentions one', () => {
        const watch = new UsageLimitWatch('pool-a');

        watch.observe({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed the usage limit page' } as never);

        expect(watch.limit).toBeUndefined();
    });

    it('describes a limit by account, kind and reset', () => {
        expect(describeUsageLimit({ account: 'pool-a', limitType: 'five_hour', resetsAt: Date.UTC(2026, 10, 2, 20) })).toBe(
            'the account "pool-a" hit its five_hour usage limit, which resets at 2026-11-02T20:00:00.000Z',
        );
    });
});
