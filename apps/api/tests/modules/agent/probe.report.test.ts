import { describe, expect, it } from 'vitest';
import { stepsExceeded } from '#modules/agent/budget.js';
import { describeProbeRun, DENIED_BASH_PROBE_STEPS } from './probe.report.js';

/**
 * Card 0252. `describeProbeRun` is the helper `cli.engine.contract.probe.ts` now passes as the
 * `expect` message for every assertion in its two probes that failed unreadably against host engine
 * 2.1.278 — see that module's own doc comment and `probe.report.ts`'s. These tests exercise the pure
 * formatting function directly: given a recorded run, does the returned string actually name the
 * attempted tool calls in order, say plainly when none were attempted, list the recorded event types
 * in order, and include or omit `truncated`/`budgetFailure`/`engineStopReason` depending on whether
 * the caller's `output` carries them — exactly AC1 through AC4.
 */
describe('describeProbeRun', () => {
    it('AC1: names two attempted calls, in order, with their path and command', () => {
        const message = describeProbeRun({
            attempted: [
                { tool: 'read', detail: '/tmp/fixture/PROJECT.md' },
                { tool: 'bash', detail: 'rm -rf src/other' },
            ],
            events: [],
        });

        expect(message).toContain('read(/tmp/fixture/PROJECT.md)');
        expect(message).toContain('bash(rm -rf src/other)');
        expect(message.indexOf('read(/tmp/fixture/PROJECT.md)')).toBeLessThan(message.indexOf('bash(rm -rf src/other)'));
    });

    it('AC2: says no tool call was attempted when none were recorded', () => {
        const message = describeProbeRun({ attempted: [], events: [] });

        expect(message).toContain('no tool call was attempted');
    });

    it('AC3: includes truncated, budgetFailure and engineStopReason when the output carries them', () => {
        const message = describeProbeRun({
            attempted: [],
            events: [],
            output: {
                truncated: true,
                budgetFailure: 'step budget exceeded: 2 steps',
                engineStopReason: 'max_turns',
            },
        });

        expect(message).toContain('truncated: true');
        expect(message).toContain('budgetFailure: step budget exceeded: 2 steps');
        expect(message).toContain('engineStopReason: max_turns');
    });

    it('AC3: omits the output fields the caller did not carry, but keeps a defined falsy one', () => {
        const message = describeProbeRun({
            attempted: [],
            events: [],
            output: { truncated: false },
        });

        expect(message).toContain('truncated: false');
        expect(message).not.toContain('budgetFailure');
        expect(message).not.toContain('engineStopReason');
    });

    it('AC3: says nothing about the outcome at all when output is omitted', () => {
        const message = describeProbeRun({ attempted: [], events: [] });

        expect(message).not.toContain('truncated');
        expect(message).not.toContain('budgetFailure');
        expect(message).not.toContain('engineStopReason');
    });

    it('AC4: lists the recorded event types in order', () => {
        const message = describeProbeRun({
            attempted: [],
            events: [{ type: 'tool.denied' }, { type: 'tool.executed' }, { type: 'tool.unguarded' }],
        });

        expect(message).toContain('events recorded, in order: tool.denied, tool.executed, tool.unguarded');
    });

    it('says no events were recorded when the events list is empty', () => {
        const message = describeProbeRun({ attempted: [], events: [] });

        expect(message).toContain('no events were recorded');
    });
});

/**
 * Card 0253. `DENIED_BASH_PROBE_STEPS` is the single budget `cli.engine.contract.probe.ts`'s
 * denied-bash `describe` block uses for both of its runs' `maxSteps`. It has to be 3 — the plan
 * read every stage agent is told to do first, plus the Bash call and the report — because a
 * tighter budget spends its only steps before ever reaching the Bash call the probe exists to
 * exercise (card 0252's own diagnostics: a run that read the plan and then ran out, having
 * attempted no other tool call at all).
 */
describe('DENIED_BASH_PROBE_STEPS', () => {
    it('AC1: is 3 — the plan read, the bash call, and the report', () => {
        expect(DENIED_BASH_PROBE_STEPS).toBe(3);
    });

    it('AC2: stepsExceeded(DENIED_BASH_PROBE_STEPS, 0) reads as a 3-step budget, not the old 2-step one', () => {
        expect(stepsExceeded(DENIED_BASH_PROBE_STEPS, 0)).toBe('step budget exceeded: 3 steps');
        expect(stepsExceeded(DENIED_BASH_PROBE_STEPS, 0)).not.toBe('step budget exceeded: 2 steps');
    });
});
