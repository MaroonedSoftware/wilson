import type { Container } from 'injectkit';
import type { AuthenticationSession } from '@maroonedsoftware/authentication';
import type { Logger } from '@maroonedsoftware/logger';
import { Duration } from 'luxon';
import { z } from 'zod';
import type { ChatOperation } from './chat.message.repository.js';
import { ChatPendingActionRepository, type PendingAction } from './chat.pending.action.repository.js';
import { ChatQuestionRepository, type PendingQuestion } from './chat.question.repository.js';
import { QUESTION_TTL, QUESTIONS_SCHEMA, type AskedQuestion } from './chat.questions.js';
import { ChatCatalog, explainError } from './chat.catalog.js';

/**
 * A tool as both engines take it: a name, a description, a zod object for its input, and an
 * `execute` that answers with text. The 'api' engine hands `input` to the AI SDK's `tool()` whole;
 * the 'cli' engine hands its `.shape` to the Agent SDK's `tool()`, which serves it over an
 * in-process MCP server. Defined once here so the two can never drift apart in what the agent may do.
 */
export interface ChatTool {
    name: string;
    description: string;
    input: z.ZodObject<z.ZodRawShape>;
    execute: (input: Record<string, unknown>) => Promise<string>;
}

/** What the tools report as they run, for the stream to show while a turn is still in progress. */
export type ChatToolEvent =
    { type: 'operation'; operation: ChatOperation } | { type: 'proposed'; action: PendingAction } | { type: 'asked'; question: PendingQuestion };

/**
 * One turn's state, shared by its tools. `operations`, `proposed` and `asked` are what the turn did,
 * kept on the stored answer; `emit` passes each one on as it happens.
 */
export interface ChatTurnContext {
    threadId: string;
    container: Container;
    logger: Logger;
    /** Who the turn is for: the session its reads run as. */
    session: AuthenticationSession;
    operations: ChatOperation[];
    proposed: PendingAction[];
    asked: PendingQuestion[];
    emit?: (event: ChatToolEvent) => void;
}

/** How long a person has to confirm a proposed change before it lapses. */
export const PROPOSAL_TTL = Duration.fromObject({ minutes: 10 });

/** A read's result is cut here before the model sees it, so one large diff cannot fill the context. */
export const RESULT_CAP = 20_000;

/**
 * One window of a result, `RESULT_CAP` long, from `offset`. A cut says where the next window starts,
 * so an operation with no narrower form of itself, such as a card with a long plan, can still be
 * read to its end.
 */
const capped = (value: unknown, offset = 0): string => {
    const text = JSON.stringify(value ?? null, null, 1);
    if (offset === 0 && text.length <= RESULT_CAP) return text;
    if (offset >= text.length) return `Nothing at offset ${offset}: the result is ${text.length} characters.`;
    const end = offset + RESULT_CAP;
    if (end >= text.length) return text.slice(offset);
    return `${text.slice(offset, end)}\n… cut at ${end} of ${text.length} characters; repeat this call with offset ${end} to read on.`;
};

const PROJECT = z
    .string()
    .optional()
    .describe('The project the operation is for, by name. Leave it out only for an operation about projects themselves, such as listing them.');

const ARGUMENTS = z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
        "The operation's arguments, exactly as its description's input schema names them: path parameters and query parameters by name, a request body under `body`.",
    );

/**
 * The five tools the chat's agent gets, in the shape of ats's meta tools: one to find an operation,
 * one to read its input schema, one to run a read, one to propose a change, and one to ask the person
 * a structured question. Nothing here runs a change. `propose_change` stores it as a pending action,
 * and only the person's confirm runs it; `ask_user` stores a pending question the same way, and only
 * their submission answers it.
 */
export const chatTools = (catalog: ChatCatalog, context: ChatTurnContext): ChatTool[] => {
    const record = (operation: ChatOperation) => {
        context.operations.push(operation);
        context.emit?.({ type: 'operation', operation });
    };

    return [
        {
            name: 'discover',
            description:
                "Search Wilson's operations by keyword: cards, the board, stages, projects, settings, learnings. Answers each match's name, what it does, and whether it is a read (run it yourself) or a change (propose it).",
            input: z.object({
                query: z.string().describe('Words describing what you want to do, e.g. "move card stage" or "card events".'),
                readOnly: z.boolean().optional().describe('true for reads only, false for changes only.'),
                limit: z.number().int().min(1).max(25).optional().describe('At most this many matches; 10 if left out.'),
            }),
            execute: async input => {
                const { query, readOnly, limit } = input as { query: string; readOnly?: boolean; limit?: number };
                const matches = catalog.search(query, limit ?? 10, readOnly);
                return capped(matches.map(({ name, description, readOnly }) => ({ name, description, readOnly })));
            },
        },
        {
            name: 'describe',
            description: "One operation's full description and the JSON Schema of its arguments. Read it before running or proposing an operation.",
            input: z.object({ name: z.string().describe('The operation name, as the search answered it.') }),
            execute: async input => {
                const entry = catalog.get((input as { name: string }).name);
                return entry ? capped(entry) : `There is no operation named "${(input as { name: string }).name}". Search for one first.`;
            },
        },
        {
            name: 'dispatch_readonly',
            description:
                'Run a read operation and answer with its result. A long result comes back in windows, each saying the offset of the next. Refuses a change: propose one instead, for the person to confirm.',
            input: z.object({
                name: z.string().describe('The operation name.'),
                project: PROJECT,
                arguments: ARGUMENTS,
                offset: z.number().int().min(0).optional().describe('Where in the result to start, from a cut result; the start if left out.'),
            }),
            execute: async input => {
                const {
                    name,
                    project,
                    arguments: args = {},
                    offset,
                } = input as { name: string; project?: string; arguments?: Record<string, unknown>; offset?: number };
                const entry = catalog.get(name);
                if (!entry) return `There is no operation named "${name}". Search for one first.`;
                if (!entry.readOnly)
                    return `"${name}" changes something, so it is not run directly. Propose it instead, and the person will confirm or decline it.`;
                try {
                    const result = await catalog.run(context.container, context.logger, context.session, name, args, project);
                    record({ name, arguments: args, project, ok: true });
                    return capped(result, offset);
                } catch (err) {
                    record({ name, arguments: args, project, ok: false });
                    return `"${name}" failed: ${explainError(err)}`;
                }
            },
        },
        {
            name: 'propose_change',
            description:
                'Propose a change for the person to confirm. Nothing changes until they do: say what you proposed and that it waits on them, never that it is done. Propose one change at a time unless they asked for several.',
            input: z.object({
                name: z.string().describe('The operation name.'),
                project: PROJECT,
                arguments: ARGUMENTS,
                summary: z.string().describe('One plain sentence saying exactly what will change, e.g. "Move 0007 back to planning."'),
            }),
            execute: async input => {
                const {
                    name,
                    project,
                    arguments: args = {},
                    summary,
                } = input as { name: string; project?: string; arguments?: Record<string, unknown>; summary: string };
                const entry = catalog.get(name);
                if (!entry) return `There is no operation named "${name}". Search for one first.`;
                if (entry.readOnly) return `"${name}" only reads. Run it directly instead of proposing it.`;
                const action = await context.container
                    .get(ChatPendingActionRepository)
                    .propose(context.threadId, { project, operation: name, arguments: args, summary, expiresIn: PROPOSAL_TTL });
                context.proposed.push(action);
                context.emit?.({ type: 'proposed', action });
                return `Proposed as change ${action.id}: "${summary}". It has not been made. The person will confirm or decline it within ${PROPOSAL_TTL.as('minutes')} minutes.`;
            },
        },
        {
            name: 'ask_user',
            description:
                'Ask the person a structured choice, or for something missing before you can carry on: up to 4 related questions in one prompt, ' +
                'each needing 2-4 suggested options. An "Other" free-text box is always offered, so never add one as an option yourself. It ' +
                'returns immediately and the answer arrives separately, not from this call: say what you asked and that it waits on them, and ' +
                'never guess the answer yourself.',
            input: QUESTIONS_SCHEMA,
            execute: async input => {
                const { questions } = input as { questions: AskedQuestion[] };
                const question = await context.container.get(ChatQuestionRepository).ask(context.threadId, { questions, expiresIn: QUESTION_TTL });
                context.asked.push(question);
                context.emit?.({ type: 'asked', question });
                return `Asked as question ${question.id}. It has not been answered. The person has ${QUESTION_TTL.as('minutes')} minutes to answer it.`;
            },
        },
    ];
};
