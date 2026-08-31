import { ActionIcon, TextInput } from '@mantine/core';
import { IconSearch, IconX } from '@tabler/icons-react';

/**
 * Card 0175: a client-side text filter over the board's toolbar, beside `NewCardControl`. The
 * filtering itself (case-insensitive substring match on `card.id`/`card.title`) lives in
 * `projects.$project.index.tsx` — this component is just the control: value in, `onChange` out, a
 * search icon so it reads as a filter rather than a title field, and a clear button that only
 * appears once there is something to clear.
 *
 * Deliberately not wired to the URL (search-param persistence is this card's Constraints' explicit
 * non-goal — it would drag `routeTree.gen.ts` into scope) — plain component state on the caller's
 * side is all this needs.
 */
export function BoardFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    return (
        <TextInput
            size="xs"
            w={220}
            placeholder="Filter cards"
            aria-label="Filter cards by id or title"
            value={value}
            onChange={event => onChange(event.currentTarget.value)}
            leftSection={<IconSearch size={14} />}
            rightSection={
                value ? (
                    <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => onChange('')} aria-label="Clear filter">
                        <IconX size={14} />
                    </ActionIcon>
                ) : null
            }
        />
    );
}
