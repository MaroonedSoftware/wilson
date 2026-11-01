import { stringify as stringifyYaml } from 'yaml';
import type { Card } from './card.js';

/**
 * Serialize a card as a markdown document with YAML frontmatter.
 *
 * This was the on-disk format when the board was a directory of files; the board is Postgres now
 * and nothing parses this format any more. What still needs it is the agent: `materializePlan`
 * (stage.dispatcher.ts) writes the card this way to `runRoot` so a stage reads title, stage,
 * dependencies and body together as one plan file (PROJECT.md decision 4).
 *
 * The body is written verbatim, never re-rendered from `sections`: reflowing prose the human (or
 * the planning agent) wrote would make the plan the agent reads differ from the one the human
 * approved.
 */
export const serializeCard = (card: Card): string => {
    const fm: Record<string, unknown> = {
        id: card.frontmatter.id,
        title: card.frontmatter.title,
        stage: card.frontmatter.stage,
    };
    if (card.frontmatter.branch) fm.branch = card.frontmatter.branch;
    fm.dependsOn = card.frontmatter.dependsOn;
    fm.retries = card.frontmatter.retries;
    // `planSha` is the historical key: it named a board-repo commit, and now names a version id.
    if (card.frontmatter.planVersionId) fm.planSha = card.frontmatter.planVersionId;
    if (card.frontmatter.external) fm.external = card.frontmatter.external;
    if (card.frontmatter.sourceClosed !== undefined) fm.sourceClosed = card.frontmatter.sourceClosed;
    if (card.frontmatter.needsHuman !== undefined) fm.needsHuman = card.frontmatter.needsHuman;
    if (card.frontmatter.needsHumanReason !== undefined) fm.needsHumanReason = card.frontmatter.needsHumanReason;
    if (card.frontmatter.splitFrom !== undefined) fm.splitFrom = card.frontmatter.splitFrom;

    return `---\n${stringifyYaml(fm).trimEnd()}\n---\n${card.body}`;
};
