/**
 * What the person might ask next, which the agent ends its answer with as a `<suggestions>` block,
 * one per line, as ats's agent does. The block is taken off the answer the person reads and offered
 * as taps.
 */

/** The most follow-ups an answer offers. */
export const MAX_SUGGESTIONS = 3;
/** The longest a follow-up may be; a longer one is dropped rather than cut. */
const MAX_SUGGESTION_LENGTH = 120;

const BLOCK = /<suggestions>([\s\S]*?)(?:<\/suggestions>|$)/i;

export interface SplitAnswer {
    /** The answer without the block. */
    text: string;
    suggestions: string[];
}

/** An answer's text and the follow-ups it offers. An answer with no block offers none. */
export const splitSuggestions = (answer: string): SplitAnswer => {
    const match = BLOCK.exec(answer);
    if (!match) return { text: answer, suggestions: [] };
    const seen = new Set<string>();
    const suggestions = match[1]!
        .split('\n')
        .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
        .filter(line => {
            const key = line.toLowerCase();
            if (line === '' || line.length > MAX_SUGGESTION_LENGTH || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, MAX_SUGGESTIONS);
    return { text: (answer.slice(0, match.index) + answer.slice(match.index + match[0].length)).trim(), suggestions };
};

/** The prompt line asking the agent for the block. */
export const SUGGESTIONS_INSTRUCTION =
    `After your answer, offer up to ${MAX_SUGGESTIONS} short follow-ups the person is likely to ask next given what you just found, ` +
    'written as they would type them to you and each something you can answer or do, in a block at the very end: ' +
    '<suggestions> on its own line, one follow-up per line starting with "- ", then </suggestions>. ' +
    'Make them specific to this answer (name the card or project), never a repeat of what was just asked. ' +
    'Leave the block out when you are waiting for them to confirm a change, or when nothing natural follows.';
