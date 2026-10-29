// Auto-generated MCP tools
// generated from [board.ck](../../../../data/contracts/board.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolHandler, McpToolHandlerMap, McpToolContext } from '@maroonedsoftware/mcp';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { BoardBootstrapService } from '#modules/board/board.bootstrap.service.js';
import { BoardService } from '#modules/board/board.service.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { PlanLintService } from '#modules/board/plan.lint.service.js';
import { PlanService } from '#modules/plan/plan.service.js';
import { StagesService } from '#modules/stages/stages.service.js';
import {
    BoardColumns,
    CardDetail,
    CardDiff,
    CardDivision,
    CardEvent,
    CardSummary,
    CardUsage,
    CardVersion,
    CreateCardRequest,
    CreatePlanCommentRequest,
    DependCardRequest,
    EditCardRequest,
    LintFinding,
    ListQuery,
    MergeResult,
    MoveCardRequest,
    PlanComment,
    PlanDraft,
    ReleaseResult,
    RenameCardRequest,
    RepositionCardRequest,
    SplitCardsRequest,
    SplitResult,
} from '../../../generated/board.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const ListCardsArgs = z.object({});
const CreateCardArgs = z.object({ body: CreateCardRequest });
const GetCardArgs = z.object({ id: z.string() });
const EditCardBodyArgs = z.object({ id: z.string(), body: EditCardRequest });
const RenameCardArgs = z.object({ id: z.string(), body: RenameCardRequest });
const MoveCardArgs = z.object({ id: z.string(), body: MoveCardRequest });
const RepositionCardArgs = z.object({ id: z.string(), body: RepositionCardRequest });
const SetCardDependencyArgs = z.object({ id: z.string(), body: DependCardRequest });
const AcknowledgeAFlaggedCardArgs = z.object({ id: z.string() });
const ApproveCardPlanArgs = z.object({ id: z.string() });
const StartCardArgs = z.object({ id: z.string() });
const ReleaseCardArgs = z.object({ id: z.string() });
const MergeCardArgs = z.object({ id: z.string() });
const GetCardDivisionArgs = z.object({ id: z.string() });
const SplitCardArgs = z.object({ id: z.string(), body: SplitCardsRequest });
const LintACardPlanArgs = z.object({ id: z.string() });
const GetAPlanDraftArgs = z.object({ id: z.string() });
const AddAPlanCommentArgs = z.object({ id: z.string(), body: CreatePlanCommentRequest });
const ListPlanCommentsArgs = z.object({ id: z.string() });
const ResolveAPlanCommentArgs = z.object({ id: z.string(), commentId: z.string() });
const ListCardEventsArgs = z.object({ id: z.string(), query: ListQuery.optional() });
const GetCardUsageArgs = z.object({ id: z.string() });
const GetCardDiffArgs = z.object({ id: z.string() });
const ListCardVersionsArgs = z.object({ id: z.string(), query: ListQuery.optional() });
const ListBoardColumnsArgs = z.object({});
const InitialiseBoardArgs = z.object({});

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/cards`
 */
@Injectable()
export class ListCardsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_cards',
        inputSchema: z.toJSONSchema(ListCardsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(CardSummary) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const result = await container.get(BoardService).list();
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards`
 */
@Injectable()
export class CreateCardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'create_card',
        inputSchema: z.toJSONSchema(CreateCardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { body } = await parseAndValidate(args, CreateCardArgs);
        const result = await container.get(BoardWriteService).create(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/cards/{id}`
 */
@Injectable()
export class GetCardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_card',
        inputSchema: z.toJSONSchema(GetCardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, GetCardArgs);
        const result = await container.get(BoardService).getById(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `PATCH /api/cards/{id}`
 */
@Injectable()
export class EditCardBodyMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'edit_card_body',
        description:
            'Not `put`. This is a partial update — only the body changes, frontmatter is not editable here\n(decision 5: stage, branch, retries are runner state; `move` is the recorded way to override\nstage) — which is exactly what `patch` means and `put`, a full replace, does not.',
        inputSchema: z.toJSONSchema(EditCardBodyArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id, body } = await parseAndValidate(args, EditCardBodyArgs);
        const result = await container.get(BoardWriteService).edit(id, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/rename`
 */
@Injectable()
export class RenameCardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'rename_card',
        description:
            'Card 0094. A sub-resource action, not `title` added to `EditCardRequest` (see the contract above):\nrenaming is still the same *kind* of act `PATCH .../id` already does — a human edits stored\ncontent, no stage reads the field as input, nothing transitions — which is why this goes through\n`board.write` in `BoardWriteService.rename`, not `writeWithEvent` the way `move` below does. It is\nnot part of `PATCH .../id` itself only because the contractkit-generated SDK method name for that\nroute (`editCardBody`) is pinned to "body", and a second field would force renaming it and every\ncaller for no behavioural gain.\n\nThe title is not the runner state decision 5 protects, either: stage, branch and retries are\nrecomputed or read by the runner itself, and `move`/`ack`/etc. are the recorded ways to override\nthem. A title is authored prose nothing downstream depends on as input — the same reason `edit`\nabove is allowed to touch `body` freely.',
        inputSchema: z.toJSONSchema(RenameCardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id, body } = await parseAndValidate(args, RenameCardArgs);
        const result = await container.get(BoardWriteService).rename(id, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/move`
 */
@Injectable()
export class MoveCardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'move_card',
        description:
            "A sub-resource action rather than `PATCH /api/cards/{id}` with a `stage` field: a move is a\nrecorded transition with its own event (`writeWithEvent`), not an edit to a stored field, and card\n0080's other five mutations — depend, ack, approve, start, release — are transitions of exactly\nthis shape. `POST .../move` establishes that convention once so five more operations can copy it\nrather than each inventing its own.",
        inputSchema: z.toJSONSchema(MoveCardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id, body } = await parseAndValidate(args, MoveCardArgs);
        const result = await container.get(BoardWriteService).move(id, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/reposition`
 */
@Injectable()
export class RepositionCardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'reposition_card',
        description:
            'Card 0091. Carries the drag an operator made in the parking lot down to a stored `position` — the\none other thing this surface lets an operator set that is not runner state (see the comment on\n`options.security` and decision 5: the runner owns stage, branch, retries; this owns nothing the\nrunner reads). Persists through `BoardRepository.setPosition`, not `write`/`writeWithEvent`: a\nreposition mints no card version and writes no `transition.written` event, on purpose — dragging a\ncard three rows down did not change what the runner will do with it. Follows the same sub-resource\nshape `move` established above.',
        inputSchema: z.toJSONSchema(RepositionCardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id, body } = await parseAndValidate(args, RepositionCardArgs);
        const result = await container.get(BoardWriteService).reposition(id, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/depend`
 */
@Injectable()
export class SetCardDependencyMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_card_dependency',
        description:
            "Card 0080's other four mutations are pure transitions or a flag action; `depend` alone edits one\nfield (`dependsOn`) the way `PATCH .../id` edits `body` — it is still a POST action rather than a\nPATCH because the edit is additive/subtractive (`remove`), not a full replace of the field the way\n`EditCardRequest` replaces `body`.",
        inputSchema: z.toJSONSchema(SetCardDependencyArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id, body } = await parseAndValidate(args, SetCardDependencyArgs);
        const result = await container.get(BoardWriteService).depend(id, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/ack`
 */
@Injectable()
export class AcknowledgeAFlaggedCardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'acknowledge_a_flagged_card',
        inputSchema: z.toJSONSchema(AcknowledgeAFlaggedCardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, AcknowledgeAFlaggedCardArgs);
        const result = await container.get(BoardWriteService).ack(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/approve`
 */
@Injectable()
export class ApproveCardPlanMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'approve_card_plan',
        inputSchema: z.toJSONSchema(ApproveCardPlanArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, ApproveCardPlanArgs);
        const result = await container.get(BoardWriteService).approve(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/start`
 */
@Injectable()
export class StartCardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'start_card',
        inputSchema: z.toJSONSchema(StartCardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDetail, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, StartCardArgs);
        const result = await container.get(BoardWriteService).start(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/release`
 */
@Injectable()
export class ReleaseCardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'release_card',
        inputSchema: z.toJSONSchema(ReleaseCardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(ReleaseResult, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, ReleaseCardArgs);
        const result = await container.get(BoardWriteService).release(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/merge`
 */
@Injectable()
export class MergeCardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'merge_card',
        description:
            "Card 0143. The merge the pipeline could never do by hand: compute the card's branch merged into\n`main` without a checkout, prove it against the project's suite, and land it — or refuse and say\nwhy. Reachable from the app rather than automatic on reaching `ready` (see this card's own\nConstraints): the trigger stays an explicit operator action, the same human gate `ready` always\nwas, this endpoint just performs what a human used to type by hand.",
        inputSchema: z.toJSONSchema(MergeCardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(MergeResult, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, MergeCardArgs);
        const result = await container.get(BoardWriteService).merge(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/cards/{id}/division`
 */
@Injectable()
export class GetCardDivisionMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_card_division',
        description:
            'Card 0113. Reads without writing: renders the division a client would confirm, before anything is\ncreated from it. Refuses, naming why, when there is nothing to act on rather than handing back an\nempty confirmation prompt.',
        inputSchema: z.toJSONSchema(GetCardDivisionArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDivision, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, GetCardDivisionArgs);
        const result = await container.get(BoardWriteService).division(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/split`
 */
@Injectable()
export class SplitCardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'split_card',
        description:
            "Card 0113. Creates one card per confirmed piece, in `planning`, records the dependencies named in\neach piece's `dependsOn`, and annotates the origin card with the ids it produced. Never moves or\ndrops the origin — card [[0090]]'s lesson about stranding dependents applies here too, and the\npieces themselves are what would strand — and never re-runs `scope-check` on what it creates:\ndeciding a split is `scope-check`'s job (card 0105), this only acts on a division an operator\nalready confirmed.",
        inputSchema: z.toJSONSchema(SplitCardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(SplitResult, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id, body } = await parseAndValidate(args, SplitCardArgs);
        const result = await container.get(BoardWriteService).split(id, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/cards/{id}/lint`
 */
@Injectable()
export class LintACardPlanMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'lint_a_card_plan',
        description:
            "Card 0193. Checks a plan against the config the runner will actually enforce — a stage's\n`CommandAllowlist`, the project's `alwaysAllowed` list, the literal shape of a `Files in scope`\nline — and reports what it finds. Read-only, like `division` above: nothing here blocks `approve`\nor any other transition (see `PlanLintService`'s own doc comment for why), so a client is free to\ncall this whenever it wants a second opinion, not only right before approving.",
        inputSchema: z.toJSONSchema(LintACardPlanArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(LintFinding) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, LintACardPlanArgs);
        const result = await container.get(PlanLintService).lint(id);
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/cards/{id}/plan/draft`
 */
@Injectable()
export class GetAPlanDraftMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_a_plan_draft',
        description:
            'Card 0140. A read, and nothing else: creates no session, cuts no worktree, writes nothing — `open`\nremains the only thing that seeds a draft. A card in `planning` that has never had a session open\nhas no `draft.md` on disk yet; that is ordinary, not a server error, so it gets a 200 with an empty\n`body` rather than a 404 — this surface\'s 404 already means "no such card" (see every other\noperation here), and reusing it for "no draft yet" would leave a client unable to tell the two\napart without inspecting `details`. [[0138]] renders an empty draft the same way it renders any\nother, with no special-case error path for a state that is completely normal.',
        inputSchema: z.toJSONSchema(GetAPlanDraftArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(PlanDraft, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, GetAPlanDraftArgs);
        const result = await container.get(PlanService).draft(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/plan/comments`
 */
@Injectable()
export class AddAPlanCommentMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'add_a_plan_comment',
        description:
            "Card 0146. Records an open comment on a passage of a card's plan draft — the anchor a client\nalready captured plus what the person said. Comments never touch `plan.md`, a card version or\nthe card body (PROJECT.md: only the resulting plan text binds downstream stages); they reach the\nagent only as anchored instructions prepended to the card's next `POST .../plan/turn`.",
        inputSchema: z.toJSONSchema(AddAPlanCommentArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(PlanComment, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id, body } = await parseAndValidate(args, AddAPlanCommentArgs);
        const result = await container.get(PlanService).addComment(id, body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/cards/{id}/plan/comments`
 */
@Injectable()
export class ListPlanCommentsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_plan_comments',
        description:
            "Card 0146. Records an open comment on a passage of a card's plan draft — the anchor a client\nalready captured plus what the person said. Comments never touch `plan.md`, a card version or\nthe card body (PROJECT.md: only the resulting plan text binds downstream stages); they reach the\nagent only as anchored instructions prepended to the card's next `POST .../plan/turn`.",
        inputSchema: z.toJSONSchema(ListPlanCommentsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(PlanComment) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, ListPlanCommentsArgs);
        const result = await container.get(PlanService).comments(id);
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/cards/{id}/plan/comments/{commentId}/resolve`
 */
@Injectable()
export class ResolveAPlanCommentMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'resolve_a_plan_comment',
        description:
            'Card 0146. Marks one comment resolved — a state the comment moves through, not a delete; it\nstays on record afterward, readable from `GET .../plan/comments`. The same 404 covers either id\nnot existing — the card, or a comment id not belonging to it.',
        inputSchema: z.toJSONSchema(ResolveAPlanCommentArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(PlanComment, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id, commentId } = await parseAndValidate(args, ResolveAPlanCommentArgs);
        const result = await container.get(PlanService).resolveComment(id, commentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/cards/{id}/events`
 */
@Injectable()
export class ListCardEventsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_card_events',
        inputSchema: z.toJSONSchema(ListCardEventsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(CardEvent) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id, query = await parseAndValidate({}, ListCardEventsArgs.shape.query.unwrap()) } = await parseAndValidate(args, ListCardEventsArgs);
        const result = await container.get(BoardService).events(id, query);
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/cards/{id}/usage`
 */
@Injectable()
export class GetCardUsageMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_card_usage',
        description:
            'Card 0263. Read-only, like `division`/`lint` above: nothing here recomputes or stores anything,\nit only sums what `EventLog` already has. A card with no `stage.passed`/`stage.failed` events on\nrecord gets zeros and an empty `stages` list, in a 200 — that is an ordinary card that has not\nrun yet, not the same fact as "no such card", which stays the 404 every other operation on this\nsurface gives.',
        inputSchema: z.toJSONSchema(GetCardUsageArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardUsage, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, GetCardUsageArgs);
        const result = await container.get(BoardService).usage(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/cards/{id}/diff`
 */
@Injectable()
export class GetCardDiffMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_card_diff',
        description:
            "Card 0265. The one thing `ready`'s human gate could not do without a terminal: read the code a\ncard actually changed. `merge-base(main, branch)..branch`, the same range `wilson card diff`\nalready uses (this card's Constraints) — never `main..branch`, which would report every file\n`main` gained since the fork as a deletion this card never made. Nothing here cuts, resumes or\nreclaims a worktree; the branch's own history in `codeRoot`'s object database is enough to answer\nthis, so the endpoint still answers for a card whose worktree was already reclaimed.",
        inputSchema: z.toJSONSchema(GetCardDiffArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardDiff, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id } = await parseAndValidate(args, GetCardDiffArgs);
        const result = await container.get(BoardService).diff(id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/cards/{id}/versions`
 */
@Injectable()
export class ListCardVersionsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_card_versions',
        inputSchema: z.toJSONSchema(ListCardVersionsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(z.object({ items: z.array(CardVersion) }), { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const { id, query = await parseAndValidate({}, ListCardVersionsArgs.shape.query.unwrap()) } = await parseAndValidate(
            args,
            ListCardVersionsArgs,
        );
        const result = await container.get(BoardService).versions(id, query);
        const resultJson = JSON.stringify({ items: result });
        return { content: [{ type: 'text', text: resultJson }], structuredContent: JSON.parse(resultJson) };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `GET /api/stages`
 */
@Injectable()
export class ListBoardColumnsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'list_board_columns',
        inputSchema: z.toJSONSchema(ListBoardColumnsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(BoardColumns, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const result = await container.get(StagesService).columns();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [board.ck](../../../../data/contracts/board.ck) `POST /api/board/init`
 */
@Injectable()
export class InitialiseBoardMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'initialise_board',
        description:
            'Gives the project a stage config an operator can start a card against immediately — a\n`runner.stage_configs` row holding the default document. This used to scaffold the sibling board\nrepo (cards/, config/stages.yaml, context/, a git repo); the board is Postgres now, stage config\nincluded, so the row is all there is to initialise, and no path is involved.',
        inputSchema: z.toJSONSchema(InitialiseBoardArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(BoardColumns, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { 'contractkit/security': 'none' },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        const result = await container.get(BoardBootstrapService).init();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerBoardMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('list_cards', container.get(ListCardsMcpTool));
    map.set('create_card', container.get(CreateCardMcpTool));
    map.set('get_card', container.get(GetCardMcpTool));
    map.set('edit_card_body', container.get(EditCardBodyMcpTool));
    map.set('rename_card', container.get(RenameCardMcpTool));
    map.set('move_card', container.get(MoveCardMcpTool));
    map.set('reposition_card', container.get(RepositionCardMcpTool));
    map.set('set_card_dependency', container.get(SetCardDependencyMcpTool));
    map.set('acknowledge_a_flagged_card', container.get(AcknowledgeAFlaggedCardMcpTool));
    map.set('approve_card_plan', container.get(ApproveCardPlanMcpTool));
    map.set('start_card', container.get(StartCardMcpTool));
    map.set('release_card', container.get(ReleaseCardMcpTool));
    map.set('merge_card', container.get(MergeCardMcpTool));
    map.set('get_card_division', container.get(GetCardDivisionMcpTool));
    map.set('split_card', container.get(SplitCardMcpTool));
    map.set('lint_a_card_plan', container.get(LintACardPlanMcpTool));
    map.set('get_a_plan_draft', container.get(GetAPlanDraftMcpTool));
    map.set('add_a_plan_comment', container.get(AddAPlanCommentMcpTool));
    map.set('list_plan_comments', container.get(ListPlanCommentsMcpTool));
    map.set('resolve_a_plan_comment', container.get(ResolveAPlanCommentMcpTool));
    map.set('list_card_events', container.get(ListCardEventsMcpTool));
    map.set('get_card_usage', container.get(GetCardUsageMcpTool));
    map.set('get_card_diff', container.get(GetCardDiffMcpTool));
    map.set('list_card_versions', container.get(ListCardVersionsMcpTool));
    map.set('list_board_columns', container.get(ListBoardColumnsMcpTool));
    map.set('initialise_board', container.get(InitialiseBoardMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerBoardMcpToolClasses(registry: Registry): void {
    registry.register(ListCardsMcpTool).useClass(ListCardsMcpTool).asSingleton();
    registry.register(CreateCardMcpTool).useClass(CreateCardMcpTool).asSingleton();
    registry.register(GetCardMcpTool).useClass(GetCardMcpTool).asSingleton();
    registry.register(EditCardBodyMcpTool).useClass(EditCardBodyMcpTool).asSingleton();
    registry.register(RenameCardMcpTool).useClass(RenameCardMcpTool).asSingleton();
    registry.register(MoveCardMcpTool).useClass(MoveCardMcpTool).asSingleton();
    registry.register(RepositionCardMcpTool).useClass(RepositionCardMcpTool).asSingleton();
    registry.register(SetCardDependencyMcpTool).useClass(SetCardDependencyMcpTool).asSingleton();
    registry.register(AcknowledgeAFlaggedCardMcpTool).useClass(AcknowledgeAFlaggedCardMcpTool).asSingleton();
    registry.register(ApproveCardPlanMcpTool).useClass(ApproveCardPlanMcpTool).asSingleton();
    registry.register(StartCardMcpTool).useClass(StartCardMcpTool).asSingleton();
    registry.register(ReleaseCardMcpTool).useClass(ReleaseCardMcpTool).asSingleton();
    registry.register(MergeCardMcpTool).useClass(MergeCardMcpTool).asSingleton();
    registry.register(GetCardDivisionMcpTool).useClass(GetCardDivisionMcpTool).asSingleton();
    registry.register(SplitCardMcpTool).useClass(SplitCardMcpTool).asSingleton();
    registry.register(LintACardPlanMcpTool).useClass(LintACardPlanMcpTool).asSingleton();
    registry.register(GetAPlanDraftMcpTool).useClass(GetAPlanDraftMcpTool).asSingleton();
    registry.register(AddAPlanCommentMcpTool).useClass(AddAPlanCommentMcpTool).asSingleton();
    registry.register(ListPlanCommentsMcpTool).useClass(ListPlanCommentsMcpTool).asSingleton();
    registry.register(ResolveAPlanCommentMcpTool).useClass(ResolveAPlanCommentMcpTool).asSingleton();
    registry.register(ListCardEventsMcpTool).useClass(ListCardEventsMcpTool).asSingleton();
    registry.register(GetCardUsageMcpTool).useClass(GetCardUsageMcpTool).asSingleton();
    registry.register(GetCardDiffMcpTool).useClass(GetCardDiffMcpTool).asSingleton();
    registry.register(ListCardVersionsMcpTool).useClass(ListCardVersionsMcpTool).asSingleton();
    registry.register(ListBoardColumnsMcpTool).useClass(ListBoardColumnsMcpTool).asSingleton();
    registry.register(InitialiseBoardMcpTool).useClass(InitialiseBoardMcpTool).asSingleton();
}
