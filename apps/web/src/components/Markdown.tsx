import { Fragment, type ReactNode } from 'react';
import { Anchor, Code, List, Stack, Text, Title } from '@mantine/core';
import { parseMarkdown } from '#src/lib/markdown.js';

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;

/** Code spans, bold, italic and links within a line of text — the inline subset the parser leaves untouched. */
function inline(text: string): ReactNode[] {
    const nodes: ReactNode[] = [];
    let last = 0;
    let key = 0;

    for (const match of text.matchAll(INLINE)) {
        const index = match.index ?? 0;
        if (index > last) nodes.push(<Fragment key={key++}>{text.slice(last, index)}</Fragment>);

        const token = match[0];
        if (token.startsWith('`')) {
            nodes.push(<Code key={key++}>{token.slice(1, -1)}</Code>);
        } else if (token.startsWith('**')) {
            nodes.push(<Text key={key++} span fw={700}>
                {token.slice(2, -2)}
            </Text>);
        } else if (token.startsWith('[')) {
            const linkEnd = token.indexOf('](');
            const label = token.slice(1, linkEnd);
            const href = token.slice(linkEnd + 2, -1);
            nodes.push(
                <Anchor key={key++} href={href} target="_blank" rel="noreferrer">
                    {label}
                </Anchor>,
            );
        } else {
            nodes.push(<Text key={key++} span fs="italic">
                {token.slice(1, -1)}
            </Text>);
        }

        last = index + token.length;
    }

    if (last < text.length) nodes.push(<Fragment key={key}>{text.slice(last)}</Fragment>);
    return nodes;
}

/**
 * Renders a plan body as markdown, not as `<pre>` text.
 *
 * Scoped to `parseMarkdown`'s subset — headings, paragraphs, lists and fenced code — which is what
 * the plan contract (PROJECT.md, Board format) actually uses. See `lib/markdown.ts` for why that
 * bound is deliberate rather than a shortcut.
 */
export function Markdown({ body }: { body: string }) {
    const blocks = parseMarkdown(body);

    return (
        <Stack gap="sm">
            {blocks.map((block, index) => {
                if (block.type === 'heading') {
                    return (
                        <Title key={index} order={Math.min(block.level + 2, 6) as 3 | 4 | 5 | 6} mt={index > 0 ? 'xs' : 0}>
                            {inline(block.text)}
                        </Title>
                    );
                }
                if (block.type === 'code') {
                    return (
                        <Code key={index} block>
                            {block.text}
                        </Code>
                    );
                }
                if (block.type === 'list') {
                    return (
                        <List key={index} type={block.ordered ? 'ordered' : 'unordered'} spacing={4} size="sm">
                            {block.items.map((item, itemIndex) => (
                                <List.Item key={itemIndex}>{inline(item)}</List.Item>
                            ))}
                        </List>
                    );
                }
                return (
                    <Text key={index} size="sm" style={{ lineHeight: 1.5 }}>
                        {inline(block.text)}
                    </Text>
                );
            })}
        </Stack>
    );
}
