import { describe, expect, it } from 'vitest';
import { activityReason, summarizeActivity } from '../src/lib/activity.js';

describe('summarizeActivity', () => {
    it('names the stage an event happened in', () => {
        expect(summarizeActivity('stage.failed', 'testing', {})).toEqual({ label: 'Failed testing', color: 'red' });
    });

    it('reads a transition as a move only when the stage changed', () => {
        expect(summarizeActivity('transition.written', 'review', { from: 'review', to: 'ready' }).label).toBe('Moved to ready');
        expect(summarizeActivity('transition.written', 'review', { from: 'review', to: 'review' }).label).toBe('Updated the card');
    });

    it('shows an unknown type as recorded rather than dropping it', () => {
        expect(summarizeActivity('something.new', null, null)).toEqual({ label: 'something.new', color: 'gray' });
    });
});

describe('activityReason', () => {
    it('reads a recorded reason and ignores anything else', () => {
        expect(activityReason({ reason: 'tests failed' })).toBe('tests failed');
        expect(activityReason({ reason: 3 })).toBeUndefined();
        expect(activityReason(null)).toBeUndefined();
    });
});
