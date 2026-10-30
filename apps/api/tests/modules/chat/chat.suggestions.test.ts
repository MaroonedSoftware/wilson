import { describe, expect, it } from 'vitest';
import { MAX_SUGGESTIONS, splitSuggestions } from '#modules/chat/chat.suggestions.js';

describe('splitSuggestions', () => {
    it('leaves an answer with no block as it is', () => {
        expect(splitSuggestions('One card: 0007.')).toEqual({ text: 'One card: 0007.', suggestions: [] });
    });

    it('takes the block off the answer and reads its lines', () => {
        const answer = 'One card: 0007.\n\n<suggestions>\n- Why is 0007 stuck?\n* Move 0007 back\n1. What did it cost?\n</suggestions>';

        expect(splitSuggestions(answer)).toEqual({
            text: 'One card: 0007.',
            suggestions: ['Why is 0007 stuck?', 'Move 0007 back', 'What did it cost?'],
        });
    });

    it('reads a block the answer ended before closing', () => {
        expect(splitSuggestions('Done.\n<suggestions>\n- Next?')).toEqual({ text: 'Done.', suggestions: ['Next?'] });
    });

    it('drops repeats and overlong lines, and keeps only the most it offers', () => {
        const lines = ['a?', 'A?', 'x'.repeat(121), 'b?', 'c?', 'd?'].map(line => `- ${line}`).join('\n');

        const { suggestions } = splitSuggestions(`Done.\n<suggestions>\n${lines}\n</suggestions>`);

        expect(suggestions).toEqual(['a?', 'b?', 'c?']);
        expect(suggestions).toHaveLength(MAX_SUGGESTIONS);
    });
});
