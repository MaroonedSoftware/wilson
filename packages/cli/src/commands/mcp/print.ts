import type { McpConnection } from '@wilson/sdk';

/** One line per tool, then its description and the arguments it describes, which a review is approving. */
export const toolLines = ({ tools }: McpConnection): string[] =>
    tools.flatMap(tool => [
        `${tool.name}  ${tool.access}${tool.needsReview ? '  NEEDS REVIEW' : ''}${tool.readOnlyHint ? '  (the server says read-only)' : ''}`,
        `    ${tool.description}`,
        `    arguments: ${JSON.stringify(tool.inputSchema)}`,
    ]);

/** A connection in a line, with how many of its tools can be used now. */
export const connectionLine = ({ name, url, secret, project, tools }: McpConnection): string => {
    const usable = tools.filter(tool => tool.access !== 'disabled' && !tool.needsReview).length;
    const waiting = tools.filter(tool => tool.needsReview).length;
    return [
        `${name}  ${url}`,
        `${usable} of ${tools.length} tools usable`,
        ...(waiting > 0 ? [`${waiting} need review`] : []),
        ...(secret !== undefined ? [`secret ${secret}`] : []),
        ...(project !== undefined ? [`only in ${project}`] : []),
    ].join('  ');
};
