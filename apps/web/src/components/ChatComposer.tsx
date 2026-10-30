import { useRef, useState, type KeyboardEvent } from 'react';
import { ActionIcon, Group, Kbd, Paper, Textarea } from '@mantine/core';
import { IconArrowUp } from '@tabler/icons-react';

/** The send button's size; the textarea's single line is padded to the same height, so the two line up. */
const SEND_SIZE = 34;

export interface ChatComposerProps {
    /** What is typed. Held by the caller, so it survives the empty state giving way to the conversation. */
    value: string;
    onChange: (value: string) => void;
    onSend: (text: string) => void;
    disabled?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    /** What to ask next: shown in the empty box, and filled in with Tab to edit or send. */
    suggestion?: string;
}

/** Where the person writes to the chat: Enter sends, Shift+Enter starts a new line, Tab takes the suggestion. */
export function ChatComposer({
    value,
    onChange,
    onSend,
    disabled = false,
    placeholder = 'Ask about the board, or tell it what to do',
    autoFocus,
    suggestion,
}: ChatComposerProps) {
    const [focused, setFocused] = useState(false);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const trimmed = value.trim();
    const canSend = trimmed.length > 0 && !disabled;
    const send = () => {
        if (!canSend) return;
        onSend(trimmed);
        textarea.current?.focus();
    };
    // Tab takes the suggestion only into an empty box; otherwise it moves focus as usual.
    const offered = value === '' && !disabled ? suggestion : undefined;
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Tab' && !event.shiftKey && offered) {
            event.preventDefault();
            onChange(offered);
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
        }
    };

    return (
        <Paper
            withBorder
            radius="lg"
            p={6}
            pl="md"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            // A click anywhere in the box (its padding, beside a short line) lands in the textarea.
            onMouseDown={event => {
                if (event.target === event.currentTarget) {
                    event.preventDefault();
                    textarea.current?.focus();
                }
            }}
            style={{
                borderColor: focused ? 'var(--mantine-color-dimmed)' : undefined,
                cursor: 'text',
                transition: 'border-color 120ms ease',
            }}
        >
            <Group gap="xs" align="flex-end" wrap="nowrap">
                <Textarea
                    ref={textarea}
                    aria-label="Message"
                    placeholder={offered ?? placeholder}
                    variant="unstyled"
                    autosize
                    minRows={1}
                    maxRows={8}
                    value={value}
                    onChange={event => onChange(event.currentTarget.value)}
                    onKeyDown={onKeyDown}
                    autoFocus={autoFocus}
                    style={{ flex: 1 }}
                    styles={{ input: { paddingBlock: 6, minHeight: SEND_SIZE, lineHeight: 1.6 } }}
                />
                {offered && (
                    <Kbd size="xs" mb={9} title="Press Tab to use the suggestion" style={{ flexShrink: 0 }}>
                        Tab
                    </Kbd>
                )}
                <ActionIcon
                    size={SEND_SIZE}
                    radius="xl"
                    variant={canSend ? 'filled' : 'default'}
                    aria-label="Send"
                    title="Send (Enter). Shift+Enter for a new line"
                    onClick={send}
                    disabled={!canSend}
                >
                    <IconArrowUp size={18} />
                </ActionIcon>
            </Group>
        </Paper>
    );
}
