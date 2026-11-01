import { describe, expect, it } from 'vitest';
import { TONE } from '#src/components/Board.js';

// TONE is exported from Board.tsx as a plain object, so it is importable and assertable here
// without rendering anything — no DOM required.
describe('TONE', () => {
    it('gives planning and backlog their own colours rather than falling through to gray', () => {
        expect(TONE.planning).toBeDefined();
        expect(TONE.planning).not.toBe('gray');
        expect(TONE.backlog).toBeDefined();
        expect(TONE.backlog).not.toBe('gray');
    });

    it("keeps planning and backlog apart from implementing's blue and from each other", () => {
        expect(TONE.planning).not.toBe(TONE.implementing);
        expect(TONE.backlog).not.toBe(TONE.implementing);
        expect(TONE.planning).not.toBe(TONE.backlog);
    });

    it('has no needs-human entry — the lane it used to colour no longer exists', () => {
        expect(TONE['needs-human']).toBeUndefined();
    });

    it("reserves red for poisoned alone, so a flagged card's red border reads as unique", () => {
        expect(TONE.poisoned).toBe('red');
        expect(Object.values(TONE).filter(tone => tone === 'red')).toEqual(['red']);
    });
});
