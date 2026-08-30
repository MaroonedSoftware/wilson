import { Fragment, type ReactNode } from 'react';
import { Anchor, Box, Code, List, Stack, Text, Title } from '@mantine/core';
import { Link, useParams } from '@tanstack/react-router';
import type { PhrasingContent, RootContent } from 'mdast';
import { parseMarkdown } from '#src/lib/markdown.js';

/** A link produced by `remarkCardRefs` points here; render it through the router instead of a
 * plain anchor so it navigates the same way every other card-to-card link in the app does. */
const CARD_LINK = /^\/cards\/(\d+)$/;

/**
 * Renders a plan body as markdown, not as `<pre>` text.
 *
 * Builds React elements straight from the mdast tree `parseMarkdown` returns, rather than through
 * `dangerouslySetInnerHTML` — card bodies are written by agents (PROJECT.md: "Imported content is
 * untrusted" already applies), and building elements from typed nodes avoids that class of bug
 * entirely instead of defending against it. `TypographyStylesProvider`, already wrapping this
 * component's callers, styles these elements via CSS the same way it styled the old ones.
 *
 * Card 0155: a `[[nnnn]]` card reference renders as a link into the project this markdown itself
 * is being read within — read from the router (`useParams({ strict: false })`) rather than threaded
 * in as a prop, since `Markdown` renders (via `CardDetailView`/`PlanningSessionPane`) only ever
 * inside a `/projects/$project/*` route now that the top-level card routes are gone.
 */
export function Markdown({ body }: { body: string }) {
    const { project } = useParams({ strict: false });
    const tree = parseMarkdown(body);
    return <Blocks nodes={tree.children} body={body} project={project} />;
}

/** The literal source text a node's `position` offsets cover, or `null` if it has none. Used only
 * as the fallback for a node type the switches below don't otherwise handle — the old line parser
 * always fell back to rendering an unrecognized line as literal paragraph text, and a first-class
 * mdast node this renderer doesn't special-case (a thematic break, raw HTML) should degrade the
 * same way rather than silently vanish. */
function sourceText(node: { position?: { start?: { offset?: number }; end?: { offset?: number } } }, body: string): string | null {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start === undefined || end === undefined) return null;
    return body.slice(start, end);
}

/**
 * One level of block nodes. Split out from `Markdown` so a blockquote or a list item can render
 * its own contents through the same path rather than flattening them into quoted or joined text.
 */
function Blocks({ nodes, body, project }: { nodes: RootContent[]; body: string; project: string | undefined }) {
    return <Stack gap="sm">{nodes.map((node, index) => renderBlock(node, index, body, project))}</Stack>;
}

function renderBlock(node: RootContent, index: number, body: string, project: string | undefined): ReactNode {
    switch (node.type) {
        case 'heading': {
            const order = Math.min(node.depth + 2, 6) as 3 | 4 | 5 | 6;
            return (
                <Title key={index} order={order} mt={index > 0 ? 'xs' : 0}>
                    {renderInline(node.children, body, project)}
                </Title>
            );
        }
        case 'paragraph':
            return (
                <Text key={index} size="sm" style={{ lineHeight: 1.5 }}>
                    {renderInline(node.children, body, project)}
                </Text>
            );
        case 'list':
            return (
                <List key={index} type={node.ordered ? 'ordered' : 'unordered'} spacing={4} size="sm">
                    {node.children.map((item, itemIndex) => (
                        <List.Item key={itemIndex}>
                            {item.children.map((child, childIndex) => renderBlock(child, childIndex, body, project))}
                        </List.Item>
                    ))}
                </List>
            );
        case 'code':
            return (
                <Code key={index} block>
                    {node.value}
                </Code>
            );
        case 'blockquote':
            return (
                <Box key={index} pl="md" style={{ borderLeft: '3px solid var(--mantine-color-gray-4)' }}>
                    <Blocks nodes={node.children} body={body} project={project} />
                </Box>
            );
        default: {
            const text = sourceText(node, body);
            return text ? (
                <Text key={index} size="sm" style={{ lineHeight: 1.5 }}>
                    {text}
                </Text>
            ) : null;
        }
    }
}

/** Code spans, bold, italic, links and card cross-references within a run of text. */
function renderInline(nodes: PhrasingContent[], body: string, project: string | undefined): ReactNode[] {
    return nodes.map((node, index) => renderInlineNode(node, index, body, project));
}

function renderInlineNode(node: PhrasingContent, key: number, body: string, project: string | undefined): ReactNode {
    switch (node.type) {
        case 'text':
            return <Fragment key={key}>{node.value}</Fragment>;
        case 'strong':
            return (
                <Text key={key} span fw={700}>
                    {renderInline(node.children, body, project)}
                </Text>
            );
        case 'emphasis':
            return (
                <Text key={key} span fs="italic">
                    {renderInline(node.children, body, project)}
                </Text>
            );
        case 'inlineCode':
            return <Code key={key}>{node.value}</Code>;
        case 'break':
            return <br key={key} />;
        case 'link': {
            const cardId = CARD_LINK.exec(node.url)?.[1];
            if (cardId && project) {
                return (
                    <Link
                        key={key}
                        to="/projects/$project/cards/$cardId"
                        params={{ project, cardId }}
                        style={{ color: 'var(--mantine-color-blue-6)' }}
                    >
                        {renderInline(node.children, body, project)}
                    </Link>
                );
            }
            return (
                <Anchor key={key} href={node.url} target="_blank" rel="noreferrer">
                    {renderInline(node.children, body, project)}
                </Anchor>
            );
        }
        default: {
            const text = sourceText(node, body);
            return text ? <Fragment key={key}>{text}</Fragment> : null;
        }
    }
}
