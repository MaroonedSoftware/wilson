import type { Container } from 'injectkit';
import type { AuthenticationSession } from '@maroonedsoftware/authentication';
import type { Logger } from '@maroonedsoftware/logger';
import { Duration } from 'luxon';
import { z } from 'zod';
import { APP_SLUG, AppsService } from '#modules/apps/apps.service.js';
import { ORCHESTRATOR_SUBJECT } from '#modules/goal/orchestrator.session.js';
import { AppGrant } from '#src/generated/apps.js';
import {
    MAX_PROPOSED_APP_HTML_BYTES,
    PROPOSE_APP_DESCRIPTION,
    PROPOSED_APP_OPERATION,
    proposedAppSummary,
    type ProposedAppArguments,
} from './chat.app.proposal.js';
import type { StoredChatAttachment } from './chat.attachment.repository.js';
import { ChatAttachmentService } from './chat.attachment.service.js';
import { MAX_CREATED_IMAGES_PER_TURN } from './chat.image.js';
import type { ChatOperation } from './chat.message.repository.js';
import { ChatPendingActionRepository, type PendingAction } from './chat.pending.action.repository.js';
import { ChatQuestionRepository, type PendingQuestion } from './chat.question.repository.js';
import { QUESTION_TTL, QUESTIONS_SCHEMA, type AskedQuestion } from './chat.questions.js';
import { ChatCatalog, explainError, type ChatCatalogEntry } from './chat.catalog.js';

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
 * One turn's state, shared by its tools. `operations`, `proposed`, `asked` and `created` are what the
 * turn did, kept on the stored answer; `emit` passes the first three on as they happen. A created image
 * has no event of its own: it reaches the browser with the answer that claims it.
 */
export interface ChatTurnContext {
    threadId: string;
    container: Container;
    logger: Logger;
    /** Who the turn is for: the session its reads run as. */
    session: AuthenticationSession;
    /** The outside tools this turn is offered (`ChatCatalog.external`). None when left out. */
    external?: readonly ChatCatalogEntry[];
    operations: ChatOperation[];
    proposed: PendingAction[];
    asked: PendingQuestion[];
    /** The images this turn drew, claimed by the answer when it is stored. */
    created: StoredChatAttachment[];
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
 * Whether a turn run as `session` may draw images: not a goal's wake-up, which nobody asked for, so
 * there is no person for the picture to be for. A follow-up after a person's confirm runs as them, and may.
 */
export const canDrawImages = (session: AuthenticationSession): boolean => session.subject !== ORCHESTRATOR_SUBJECT;

/** `]` would end the markdown image node early, and a newline would break it; nothing else needs escaping. */
const markdownAlt = (alt: string): string => alt.replace(/[[\]\r\n]+/g, ' ').trim() || 'image';

/**
 * The tools the chat's agent gets, in the shape of ats's meta tools: one to find an operation, one to
 * read its input schema, one to run a read, one to propose a change, one to propose an operator app,
 * one to draw an image, and one to ask the person a structured question. Nothing here runs a change.
 * `propose_change` and `propose_app` store it as a pending action, and only the person's confirm runs
 * it; `ask_user` stores a pending question the same way, and only their submission answers it.
 *
 * `create_image` does write a row, and is still inside that rule: it adds a picture to the thread it
 * is already answering in, seen only by the person it is answering, and changes nothing on the board,
 * so there is nothing for them to confirm. The row stays unclaimed until the answer that shows it is
 * stored, and a turn that stores no answer leaves it for `sweepUnclaimed`.
 *
 * A goal's wake-up gets neither `propose_app` nor `create_image`: nobody asked for that turn, an app's
 * source is what a person is asked to read, so it should not arrive unbidden from text the turn read,
 * and a picture is for the person being answered ({@link canDrawImages}).
 */
export const chatTools = (catalog: ChatCatalog, context: ChatTurnContext): ChatTool[] => {
    const record = (operation: ChatOperation) => {
        context.operations.push(operation);
        context.emit?.({ type: 'operation', operation });
    };

    const proposeApp: ChatTool = {
        name: 'propose_app',
        description: PROPOSE_APP_DESCRIPTION,
        input: z.object({
            slug: z.string().describe('Lowercase letters, digits and hyphens, starting with a letter or digit, at most 63 characters.'),
            name: z.string().min(1).max(100).describe('What the app is called in Wilson.'),
            description: z.string().max(500).optional().describe('One line saying what it shows.'),
            html: z.string().min(1).describe('The whole file.'),
            requestedGrants: z.array(AppGrant).describe('What the app uses. The person decides what it gets.'),
        }),
        execute: async input => {
            const { slug, name, description, html, requestedGrants } = input as ProposedAppArguments;
            if (!APP_SLUG.test(slug))
                return `"${slug}" is not a slug: use 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit.`;
            if (name.trim().length === 0) return 'The name must not be blank.';
            const bytes = Buffer.byteLength(html, 'utf8');
            if (bytes > MAX_PROPOSED_APP_HTML_BYTES)
                return `The file is ${bytes} bytes, and a proposed app may be at most ${MAX_PROPOSED_APP_HTML_BYTES}.`;
            if (await context.container.get(AppsService).exists(slug))
                return `An app named "${slug}" is already installed, and this cannot replace one. Pick another slug, or tell the person they can replace it themselves in Settings, then Apps.`;
            const args: ProposedAppArguments = { slug, name: name.trim(), ...(description ? { description } : {}), html, requestedGrants };
            const proposals = context.container.get(ChatPendingActionRepository);
            const waiting = await proposals.findPending(context.threadId, { operation: PROPOSED_APP_OPERATION, arguments: args });
            if (waiting) return `Already proposed as change ${waiting.id}. It still waits on the person, so do not propose it again.`;
            const action = await proposals.propose(context.threadId, {
                operation: PROPOSED_APP_OPERATION,
                arguments: args,
                summary: proposedAppSummary(args.name, html),
                expiresIn: PROPOSAL_TTL,
            });
            context.proposed.push(action);
            context.emit?.({ type: 'proposed', action });
            return `Proposed as change ${action.id}. It has not been installed. The person will read it and confirm or decline it within ${PROPOSAL_TTL.as('minutes')} minutes.`;
        },
    };

    const createImage: ChatTool = {
        name: 'create_image',
        description:
            'Draw an image to show in your answer: an SVG document you write yourself (not Mermaid, and not a prompt to an image model), or base64 image bytes. ' +
            'It answers with a line of markdown. Paste that markdown into this same answer where the image belongs: nothing is shown unless you do. ' +
            `At most ${MAX_CREATED_IMAGES_PER_TURN} images in one answer.`,
        input: z.object({
            kind: z.enum(['svg', 'bytes']).describe('svg for an SVG document you write yourself, bytes for base64 image bytes.'),
            svg: z
                .string()
                .optional()
                .describe('The whole SVG document, when kind is svg. Declare xmlns="http://www.w3.org/2000/svg" on its root, and use no scripts, event handlers or links.'),
            bytes: z.string().optional().describe('Base64 PNG, JPEG, WebP or GIF bytes, when kind is bytes.'),
            filename: z.string().min(1).max(120).describe('A short file name for the image, e.g. "stage-flow.svg".'),
            alt: z.string().min(1).max(200).describe('Alt text saying what the image shows.'),
        }),
        execute: async input => {
            const { kind, svg, bytes, filename, alt } = input as { kind: 'svg' | 'bytes'; svg?: string; bytes?: string; filename: string; alt: string };
            if (context.created.length >= MAX_CREATED_IMAGES_PER_TURN)
                return `You have already made ${MAX_CREATED_IMAGES_PER_TURN} images in this answer, which is the most one answer can show. Use one of those instead.`;
            if (kind === 'svg' && !svg)
                return 'You asked for kind "svg" but sent no SVG source. Call again with the SVG document in the svg argument.';
            if (kind === 'bytes' && !bytes)
                return 'You asked for kind "bytes" but sent no base64 image bytes. Call again with the base64 image bytes in the bytes argument.';
            let stored: StoredChatAttachment;
            try {
                stored = await context.container
                    .get(ChatAttachmentService)
                    .create(context.threadId, kind === 'svg' ? { kind: 'svg', source: svg! } : { kind: 'bytes', base64: bytes! }, filename);
            } catch (err) {
                return explainError(err);
            }
            context.created.push(stored);
            return `Made image ${stored.id}. Show it in your answer as: ![${markdownAlt(alt)}](/api/chat/threads/${context.threadId}/attachments/${stored.id}) — nothing is shown unless you do.`;
        },
    };

    const drawing = canDrawImages(context.session);

    return [
        ...(context.session.subject === ORCHESTRATOR_SUBJECT ? [] : [proposeApp]),
        {
            name: 'discover',
            description:
                "Search Wilson's operations by keyword: cards, the board, stages, projects, settings, learnings, and the tools of any outside services connected. Answers each match's name, what it does, and whether it is a read (run it yourself) or a change (propose it).",
            input: z.object({
                query: z.string().describe('Words describing what you want to do, e.g. "move card stage" or "card events".'),
                readOnly: z.boolean().optional().describe('true for reads only, false for changes only.'),
                limit: z.number().int().min(1).max(25).optional().describe('At most this many matches; 10 if left out.'),
            }),
            execute: async input => {
                const { query, readOnly, limit } = input as { query: string; readOnly?: boolean; limit?: number };
                const matches = catalog.search(query, limit ?? 10, readOnly, context.external);
                return capped(matches.map(({ name, description, readOnly }) => ({ name, description, readOnly })));
            },
        },
        {
            name: 'describe',
            description: "One operation's full description and the JSON Schema of its arguments. Read it before running or proposing an operation.",
            input: z.object({ name: z.string().describe('The operation name, as the search answered it.') }),
            execute: async input => {
                const entry = catalog.get((input as { name: string }).name, context.external);
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
                const entry = catalog.get(name, context.external);
                if (!entry) return `There is no operation named "${name}". Search for one first.`;
                if (!entry.readOnly)
                    return `"${name}" changes something, so it is not run directly. Propose it instead, and the person will confirm or decline it.`;
                try {
                    const result = await catalog.run(context.container, context.logger, context.session, name, args, project, { mustBeRead: true });
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
                const entry = catalog.get(name, context.external);
                if (!entry) return `There is no operation named "${name}". Search for one first.`;
                if (entry.readOnly) return `"${name}" only reads. Run it directly instead of proposing it.`;
                const proposals = context.container.get(ChatPendingActionRepository);
                const waiting = await proposals.findPending(context.threadId, { project, operation: name, arguments: args });
                if (waiting)
                    return `Already proposed as change ${waiting.id}: "${waiting.summary}". It still waits on the person, so do not propose it again.`;
                const action = await proposals.propose(context.threadId, {
                    project,
                    operation: name,
                    arguments: args,
                    summary,
                    expiresIn: PROPOSAL_TTL,
                });
                context.proposed.push(action);
                context.emit?.({ type: 'proposed', action });
                return `Proposed as change ${action.id}: "${summary}". It has not been made. The person will confirm or decline it within ${PROPOSAL_TTL.as('minutes')} minutes.`;
            },
        },
        ...(drawing ? [createImage] : []),
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
