import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { compactMessages } from '#modules/agent/compact.messages.js';

const toolMessage = (value: string): ModelMessage => ({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: `c-${value}`, toolName: 'read', output: { type: 'text', value } }],
});

const assistantMessage = (text: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });

const outputOf = (message: ModelMessage): string => {
    const part = (message.content as { output?: { value?: string } }[])[0];
    return part?.output?.value ?? '';
};

/**
 * Card 0002 reached 3.6M tokens on its second attempt and was refused for exceeding the provider's
 * 1M context window. Every step resends the conversation, so tool results accumulate.
 */
describe('compactMessages', () => {
    const build = (count: number) => Array.from({ length: count }, (_, i) => toolMessage(`payload-${i}`));

    it('leaves a short conversation alone', () => {
        const messages = [assistantMessage('start'), ...build(5)];
        expect(compactMessages(messages)).toEqual(messages);
    });

    it('elides tool output beyond the recent window', () => {
        const compacted = compactMessages([assistantMessage('start'), ...build(60)]);
        expect(outputOf(compacted[5]!)).toContain('elided');
    });

    it('keeps recent tool output verbatim', () => {
        const compacted = compactMessages([assistantMessage('start'), ...build(60)]);
        expect(outputOf(compacted[compacted.length - 1]!)).toBe('payload-59');
    });

    it('always keeps the first message, which carries the plan path', () => {
        const compacted = compactMessages([assistantMessage('your plan is at /run/plan.md'), ...build(60)]);
        expect(compacted[0]).toEqual(assistantMessage('your plan is at /run/plan.md'));
    });

    it('never elides the assistant’s own turns', () => {
        // The model needs to remember what it did and why far more than it needs the text of a file
        // it read forty steps ago.
        const messages = [assistantMessage('start'), assistantMessage('I will edit show.command.ts'), ...build(60)];
        expect(compactMessages(messages)[1]).toEqual(assistantMessage('I will edit show.command.ts'));
    });

    it('preserves message count and ordering', () => {
        const messages = [assistantMessage('start'), ...build(60)];
        const compacted = compactMessages(messages);
        expect(compacted).toHaveLength(messages.length);
        expect(compacted.map(m => m.role)).toEqual(messages.map(m => m.role));
    });
});
