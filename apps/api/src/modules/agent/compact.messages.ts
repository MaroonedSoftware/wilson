import type { ModelMessage } from 'ai';

/** Steps whose tool output survives verbatim. Older results are replaced by a marker. */
const KEEP_RECENT_MESSAGES = 24;

const ELIDED = '[earlier tool output elided to stay within the context window — re-read the file if you still need it]';

/**
 * Sliding-window compaction over the conversation.
 *
 * Every step resends the whole conversation, so tool results accumulate quadratically: card 0002
 * reached 3.6M tokens on its second attempt and was refused for exceeding the 1M context window.
 * Owning the loop means owning context management — it is the part a vendor harness would have
 * handled, and the trade PROJECT.md made when it chose ToolLoopAgent over HarnessAgent.
 *
 * Only tool *results* are elided, never the assistant's own reasoning or its tool calls: the model
 * needs to remember what it did and why, far more than it needs the full text of a file it read
 * forty steps ago. The first message is always kept — it carries the plan path and the card.
 */
export const compactMessages = (messages: ModelMessage[]): ModelMessage[] => {
    if (messages.length <= KEEP_RECENT_MESSAGES + 1) return messages;

    const cutoff = messages.length - KEEP_RECENT_MESSAGES;

    return messages.map((message, index) => {
        // Index 0 is the prompt; everything from the cutoff on is recent enough to keep.
        if (index === 0 || index >= cutoff) return message;
        if (message.role !== 'tool' || !Array.isArray(message.content)) return message;

        return {
            ...message,
            content: message.content.map(part =>
                part.type === 'tool-result' ? { ...part, output: { type: 'text' as const, value: ELIDED } } : part,
            ),
        };
    });
};
