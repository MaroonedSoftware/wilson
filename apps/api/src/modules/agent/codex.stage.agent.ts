import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { z } from 'zod';
import { PASSED_THROUGH } from '#modules/stages/run.command.js';
import { budgetedInputTokens, contextBudgetExceeded, engineSilent, overBudget, stepsExceeded, wallClockExceeded } from './budget.js';
import { createToolGuard, ENGINE_PASSED_THROUGH } from './cli.stage.agent.js';
import { CodexConnection, type CodexExit, type CodexNotification, type CodexServerRequest } from './codex.connection.js';
import { buildRunTrace, type RunTrace } from './run.trace.js';
import { REPORT_RESULT_PATH, SCRATCH_PREFIX } from './scope.guard.js';
import { StageInterrupt } from './stage.interrupt.js';
import { StageAgent, type AgentRunInput, type AgentRunOutput } from './stage.agent.js';
import { requestScope } from './tools/scope.tool.js';
import { toolHost, type ToolContext } from './tools/index.js';

const REPORT_TOOL = 'report_result';
const REQUEST_SCOPE_TOOL = 'request_scope';

/** What the host's environment gives the engine: never a Claude credential or Claude's own settings. */
const codexEnv = (): NodeJS.ProcessEnv => {
    const names = [...ENGINE_PASSED_THROUGH.filter(name => name !== 'CLAUDE_CONFIG_DIR'), ...PASSED_THROUGH, 'CODEX_HOME'];
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && (names.includes(key) || key.startsWith('LC_') || key.startsWith('TEST_DATABASE_'))) env[key] = value;
    }
    return env;
};

/**
 * The inner script of a command the engine reports still wrapped in its login shell, as
 * `/bin/zsh -lc 'pnpm test'`. Only the single-quoted form, which cannot hide anything inside it from
 * the allowlist; anything else goes to the allowlist as it is, and is refused there.
 */
export const unwrapShell = (command: string): string => /^(?:\S*\/)?(?:ba|z)?sh -l?c '([^']*)'$/.exec(command.trim())?.[1] ?? command;

/** The engine's own tool items, which a stage's guards are meant to see before they run. */
const TOOL_ITEMS = new Set([
    'commandExecution',
    'fileChange',
    'dynamicToolCall',
    'mcpToolCall',
    'webSearch',
    'collabAgentToolCall',
    'imageGeneration',
]);

interface FileChange {
    path: string;
    kind?: { type?: string; move_path?: string | null };
}

/** Every path a file change touches, including where an update moves a file to. */
const changedPaths = (changes: FileChange[]): string[] => changes.flatMap(({ path, kind }) => (kind?.move_path ? [path, kind.move_path] : [path]));

interface Turn {
    id: string;
    status: string;
    error?: { message?: string; codexErrorInfo?: unknown; additionalDetails?: string | null } | null;
}

/**
 * Runs a stage through OpenAI's Codex engine, driving `codex app-server` over its stdio.
 *
 * **Guarding.** Codex runs commands and applies patches itself, so `ScopeGuard` and
 * `CommandAllowlist` are put back through the app-server's approval requests: with `approvalPolicy:
 * untrusted` and `approvalsReviewer: user`, the engine asks this process before a command or a file
 * change, and `createToolGuard`, the same guard the `cli` adapter uses, answers. Every approval is
 * for that one call: `acceptForSession` is never sent, and neither is any policy amendment.
 *
 * **What that does not cover.** Codex documents `untrusted` as running commands it considers safe
 * without asking, and reads through those are limited only by what the engine's sandbox allows. The
 * live probes in `codex.engine.contract.probe.ts` that would measure this have not been run. So
 * this adapter assumes a read can reach anything on the host and a write can skip approval, and
 * refuses a stage not marked `isolated` for that reason. A call the guard never saw is recorded as
 * `tool.unguarded`, and `StageDispatcher.checkBeforeCommit` still checks the tree afterwards.
 *
 * **Tools.** `report_result` and `request_scope` are dynamic tools (experimental in the app-server,
 * hence `experimentalApi`), answered here over `item/tool/call`. Deleting a file needs no tool of its
 * own: it is a file change, which is scope-checked like any other. `report_result` takes the result
 * itself rather than a path, since a dynamic tool's arguments have only this stdio to cross.
 *
 * **Refusals.** An approval answer carries only a decision, so the reason would never reach the
 * model. It follows as `turn/steer`, in the running turn, so a model is told what to do differently.
 *
 * **Ending.** A stage ends the moment `report_result` is accepted, rather than when the turn does:
 * an edit made after the result was reported is what `checkBeforeCommit` exists to catch, and this
 * engine leaves room to not have one at all. Usage then stops at the last figure the engine sent.
 *
 * `provider` means nothing here (the engine runs OpenAI models), and neither does `maxBudgetUsd`,
 * which this engine has no option for. `stage.sandbox` does not apply either: the engine's own
 * sandbox is always on, with `stage.networkAccess` saying whether its commands get a network.
 */
@Injectable()
export class CodexStageAgent extends StageAgent {
    // `interrupts` is optional as in `CliStageAgent`: none means nothing can interrupt the run.
    constructor(
        private readonly logger: Logger,
        private readonly interrupts?: StageInterrupt,
    ) {
        super();
    }

    async run(input: AgentRunInput): Promise<AgentRunOutput> {
        const output = await this.attempt(input);
        if (!output.resumeFailed) return output;

        this.logger.warn(`could not resume ${input.context.cardId}'s engine thread; starting a new one in the same worktree`);
        return this.attempt({ ...input, resume: {} });
    }

    private async attempt({ stage, context, planPath, learningsPath, title, resultSchema, baseSha, resume }: AgentRunInput): Promise<AgentRunOutput> {
        const host = toolHost(context);
        // Checked here as well as on a routing write: the document can drop `isolated` after one.
        if (!stage.isolated) {
            return {
                truncated: true,
                engineFailure: `stage "${stage.name}" must be marked isolated to run on the codex adapter: reads through this engine are not limited to the worktree`,
            };
        }
        if (!host.spawnCodex) {
            return { truncated: true, engineFailure: `host "${host.name}" cannot start the codex engine` };
        }

        const schema = resultSchema as z.ZodTypeAny;
        const canWrite = stage.worktree === 'rw';
        let reported: unknown;
        let reportSeen = false;
        let anyToolSeen = false;
        let summary = '';
        let steps = 0;
        let denied = 0;
        let threadId: string | undefined;
        let usage: AgentRunOutput['usage'];
        const reads: (string | undefined)[] = [];
        const asked = new Set<string>();
        const fileChanges = new Map<string, FileChange[]>();
        const approvedPaths = new Map<string, Set<string>>();

        let stoppedBecause: 'wall-clock' | 'silent' | 'steps' | 'context' | 'input-tokens' | 'interrupted' | 'reported' | undefined;
        let budgetFailure: string | undefined;
        // What `request_scope` threw under the `kickback` policy, for this method to throw in turn.
        let thrown: unknown;
        // The engine's latest complaint, which says why a run that went quiet did.
        let lastError: string | undefined;
        let stop!: () => void;
        const stopped = new Promise<typeof STOPPED>(resolve => {
            stop = () => resolve(STOPPED);
        });
        const stopFor = (reason: NonNullable<typeof stoppedBecause>, failure?: string): void => {
            if (stoppedBecause) return;
            stoppedBecause = reason;
            budgetFailure = failure;
            stop();
        };

        const startedAt = Date.now();
        const wallClock = setTimeout(() => stopFor('wall-clock', wallClockExceeded(stage.maxWallClockMs)), stage.maxWallClockMs);
        wallClock.unref();
        const idleGuards = stage.maxIdleMs < stage.maxWallClockMs;
        let idle: NodeJS.Timeout | undefined;
        const beat = (): void => {
            if (!idleGuards) return;
            clearTimeout(idle);
            idle = setTimeout(() => stopFor('silent'), stage.maxIdleMs);
            idle.unref();
        };

        const guard = createToolGuard(
            context,
            stage.worktree,
            () => {
                denied += 1;
            },
            beat,
        );
        const signal = new AbortController().signal;
        const consult = async (tool: string, input: Record<string, unknown>, id: string) => {
            const decision = await guard(tool, input, { signal, toolUseID: id, requestId: id } as never);
            return decision?.behavior === 'deny' ? decision.message : undefined;
        };

        const append = (
            type: 'tool.denied' | 'tool.unguarded' | 'turn.empty' | 'engine.failed' | 'stage.engine-session',
            payload: Record<string, unknown>,
        ) =>
            context.events
                .append({ project: context.project, cardId: context.cardId, stage: context.stage, type, payload })
                .catch((error: unknown) => this.logger.warn(`could not record ${type} for ${context.cardId}: ${String(error)}`));

        const tellModel = (turnId: unknown, reason: string): void => {
            if (!threadId || typeof turnId !== 'string') return;
            connection
                .request('turn/steer', {
                    threadId,
                    expectedTurnId: turnId,
                    input: [{ type: 'text', text: `Wilson refused that call: ${reason}`, text_elements: [] }],
                })
                .catch(() => {});
        };

        /** A refusal that is not the guard's to make, recorded the way one of its refusals is. */
        const refuse = async (reason: string, detail: Record<string, unknown>, turnId: unknown) => {
            denied += 1;
            await append('tool.denied', { reason, ...detail });
            tellModel(turnId, reason);
            return { decision: 'decline' };
        };

        const approveCommand = async (params: Record<string, unknown>) => {
            const { itemId, turnId, approvalId } = params as { itemId: string; turnId: unknown; approvalId?: string | null };
            asked.add(itemId);
            if (params.kind !== undefined && params.kind !== 'command') {
                return refuse('writing to a running command is not available to this stage', { tool: 'Bash' }, turnId);
            }
            if (params.networkApprovalContext || params.proposedNetworkPolicyAmendments) {
                return refuse('network access is not something a stage can ask for', { tool: 'Bash' }, turnId);
            }
            if (typeof params.command !== 'string') return refuse('the engine did not say what it would run', { tool: 'Bash' }, turnId);
            const cwd = typeof params.cwd === 'string' ? params.cwd : context.worktreeRoot;
            const where = await context.scope.checkSearch(cwd);
            if (!where.allowed) return refuse(where.reason, { tool: 'Bash', command: params.command }, turnId);

            const refusal = await consult('Bash', { command: unwrapShell(params.command) }, approvalId ?? itemId);
            if (refusal === undefined) return { decision: 'accept' };
            tellModel(turnId, refusal);
            return { decision: 'decline' };
        };

        const approveFileChange = async (params: Record<string, unknown>) => {
            const { itemId, turnId } = params as { itemId: string; turnId: unknown };
            asked.add(itemId);
            if (params.grantRoot) return refuse('a stage cannot ask for a directory to stay writable', { tool: 'Write' }, turnId);
            // A patch is all or nothing, so nothing is recorded as written unless all of it may be.
            const paths = changedPaths(fileChanges.get(itemId) ?? []);
            if (paths.length === 0) return refuse('the engine did not say what it would change', { tool: 'Write' }, turnId);
            const refused: string[] = [];
            for (const path of paths) {
                const decision = await context.scope.check(path);
                const runnerChannel = decision.path === REPORT_RESULT_PATH || decision.path.startsWith(SCRATCH_PREFIX);
                if (!decision.allowed || (!canWrite && !runnerChannel)) refused.push(path);
            }
            const reasons: string[] = [];
            for (const path of refused.length > 0 ? refused : paths) {
                const refusal = await consult('Write', { file_path: path }, `${itemId}:${path}`);
                if (refusal !== undefined) reasons.push(refusal);
            }
            if (reasons.length === 0) {
                approvedPaths.set(itemId, new Set(paths));
                return { decision: 'accept' };
            }
            tellModel(turnId, reasons.join(' '));
            return { decision: 'decline' };
        };

        const toolReply = (text: string, success: boolean) => ({ contentItems: [{ type: 'inputText', text }], success });

        const callTool = async (params: Record<string, unknown>) => {
            const args = (params.arguments ?? {}) as Record<string, unknown>;
            if (params.tool === REPORT_TOOL) {
                const validated = schema.safeParse(args);
                if (!validated.success) return toolReply(`error: does not match this stage's result schema: ${validated.error.message}`, false);
                reported = validated.data;
                stopFor('reported');
                return toolReply('reported', true);
            }
            if (params.tool === REQUEST_SCOPE_TOOL && canWrite) {
                return toolReply(await requestScope(context, String(args.path ?? ''), String(args.reason ?? '')), true);
            }
            return toolReply(`error: ${String(params.tool)} is not available to this stage`, false);
        };

        const onRequest = async ({ method, params }: CodexServerRequest): Promise<unknown> => {
            beat();
            try {
                if (method === 'item/commandExecution/requestApproval') return await approveCommand(params);
                if (method === 'item/fileChange/requestApproval') return await approveFileChange(params);
                if (method === 'item/tool/call') return await callTool(params);
            } catch (error) {
                thrown = error;
                stop();
                throw error;
            }
            // Everything else asks for something a stage has no one to ask: extra permissions, input
            // from a person, or a sign-in. Answered with an error, so nothing is granted by default.
            throw new Error(`${method} is not available to a stage`);
        };

        const itemStarted = (item: Record<string, unknown>): void => {
            if (item.type === 'fileChange') fileChanges.set(String(item.id), (item.changes ?? []) as FileChange[]);
            if (item.type === 'dynamicToolCall' && item.tool === REPORT_TOOL) reportSeen = true;
            if (item.type === 'commandExecution') {
                for (const action of (item.commandActions ?? []) as { type?: string; path?: string }[]) {
                    if (action.type === 'read') reads.push(action.path);
                }
            }
            if (!TOOL_ITEMS.has(String(item.type))) return;
            anyToolSeen = true;
            // Reporting ends the stage, so a stage on its last step can still do it.
            if (item.type === 'dynamicToolCall' && item.tool === REPORT_TOOL) return;
            steps += 1;
            // Refused calls are not charged, up to a limit, as in `CliStageAgent`.
            if (steps >= stage.maxSteps + Math.min(denied, stage.maxSteps)) {
                this.logger.warn(`codex stage reached its step budget of ${stage.maxSteps} (${denied} refused calls not charged)`);
                stopFor('steps', stepsExceeded(stage.maxSteps, denied));
            }
        };

        const itemCompleted = async (item: Record<string, unknown>): Promise<void> => {
            if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) summary = item.text.trim();
            if (!TOOL_ITEMS.has(String(item.type)) || item.type === 'dynamicToolCall' || item.status === 'declined') return;
            // A patch can still change after it is approved, so what it ended up touching is compared too.
            const approved = approvedPaths.get(String(item.id));
            if (approved) {
                const unapproved = changedPaths((item.changes ?? []) as FileChange[]).filter(path => !approved.has(path));
                if (unapproved.length > 0) await append('tool.unguarded', { tool: 'Write', path: unapproved.join(', ') });
                return;
            }
            if (asked.has(String(item.id))) return;
            const detail =
                item.type === 'commandExecution'
                    ? { tool: 'Bash', command: String(item.command ?? '') }
                    : item.type === 'fileChange'
                      ? { tool: 'Write', path: changedPaths((item.changes ?? []) as FileChange[]).join(', ') }
                      : { tool: String(item.type) };
            this.logger.warn(`codex stage ran ${detail.tool} without asking (item ${String(item.id)})`);
            await append('tool.unguarded', detail);
        };

        const tokensUsed = (params: Record<string, unknown>): void => {
            const { total, last, modelContextWindow } = (params.tokenUsage ?? {}) as {
                total?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
                last?: { inputTokens: number };
                modelContextWindow?: number | null;
            };
            if (total) {
                // This engine's `inputTokens` includes what was cached; a stage's figures keep them apart.
                usage = {
                    inputTokens: Math.max(0, total.inputTokens - total.cachedInputTokens),
                    outputTokens: total.outputTokens,
                    cachedInputTokens: total.cachedInputTokens,
                };
                const failure = overBudget(budgetedInputTokens(usage), stage.maxInputTokens);
                if (failure) stopFor('input-tokens', failure);
            }
            if (last && modelContextWindow) {
                const failure = contextBudgetExceeded(stage.maxContextWindowFraction, (last.inputTokens / modelContextWindow) * 100);
                if (failure) stopFor('context', failure);
            }
        };

        let completedTurn: (turn: Turn) => void;
        const turnCompleted = new Promise<Turn>(resolve => {
            completedTurn = resolve;
        });
        const onNotification = ({ method, params }: CodexNotification): void => {
            // An engine retrying a model it cannot reach reports each try, which is not progress: left
            // to count as a sign of life, a signed-out engine spends the stage's whole wall clock.
            if (method === 'error') {
                lastError = ((params.error ?? {}) as { message?: string }).message;
                return;
            }
            beat();
            if (method === 'item/started') itemStarted((params.item ?? {}) as Record<string, unknown>);
            if (method === 'item/fileChange/patchUpdated') fileChanges.set(String(params.itemId), (params.changes ?? []) as FileChange[]);
            if (method === 'item/completed') void itemCompleted((params.item ?? {}) as Record<string, unknown>);
            if (method === 'thread/tokenUsage/updated') tokensUsed(params);
            if (method === 'turn/completed' && params.threadId === threadId) completedTurn(params.turn as Turn);
        };

        const connection = new CodexConnection(
            host.spawnCodex({ command: 'codex', args: ['app-server'], cwd: context.worktreeRoot, env: codexEnv() }),
            { onRequest, onNotification },
        );

        const networkAccess = stage.networkAccess ?? false;
        const trace = (): { trace: RunTrace } => ({ trace: buildRunTrace(reads, summary || undefined) });
        const dropped = (): { resultDropped?: boolean } => (reported === undefined && reportSeen ? { resultDropped: true } : {});
        const interrupted = (): AgentRunOutput => {
            const sessionId = threadId ?? resume?.sessionId;
            return {
                usage,
                truncated: true,
                interrupted: { ...(sessionId && { sessionId }), wallClockMs: Date.now() - startedAt, steps },
                ...trace(),
            };
        };
        const interrupt = (): void => stopFor('interrupted');
        if (this.interrupts?.signal.aborted) interrupt();
        this.interrupts?.signal.addEventListener('abort', interrupt, { once: true });

        const engineFailed = async (message: string, exit?: CodexExit): Promise<AgentRunOutput> => {
            await append('engine.failed', {
                message,
                errorClass: 'codex',
                ...(typeof exit?.code === 'number' && { exitCode: exit.code }),
                ...(exit?.signal && { signal: exit.signal }),
                ...(connection.stderr && { stderr: connection.stderr }),
            });
            this.logger.warn(`codex stage engine failed: ${message}`);
            return {
                result: reported ?? (summary ? { summary } : undefined),
                usage,
                truncated: true,
                engineFailure: `the engine failed: ${message}${connection.stderr ? ` — stderr: ${connection.stderr}` : ''}`,
                ...dropped(),
                ...trace(),
            };
        };

        beat();
        try {
            const start = async (): Promise<Turn> => {
                await connection.initialize('wilson', true);

                const sandbox = canWrite ? 'workspace-write' : 'read-only';
                const thread = {
                    cwd: context.worktreeRoot,
                    model: stage.model,
                    approvalPolicy: 'untrusted',
                    approvalsReviewer: 'user',
                    sandbox,
                    // Pinned so this engine's tool surface does not depend on the host's own config.
                    config: { web_search: 'disabled', mcp_servers: {}, shell_environment_policy: { ignore_default_excludes: false } },
                };
                let resumed = false;
                if (resume?.sessionId) {
                    try {
                        await connection.request('thread/resume', { threadId: resume.sessionId, ...thread, excludeTurns: true });
                        threadId = resume.sessionId;
                        resumed = true;
                    } catch {
                        throw RESUME_FAILED;
                    }
                } else {
                    const started = await connection.request<{ thread: { id: string } }>('thread/start', {
                        ...thread,
                        ephemeral: false,
                        dynamicTools: dynamicTools(schema, canWrite),
                    });
                    threadId = started.thread.id;
                }
                await append('stage.engine-session', { sessionId: threadId });

                await connection.request('turn/start', {
                    threadId,
                    approvalPolicy: 'untrusted',
                    approvalsReviewer: 'user',
                    // Tmp stays writable: test suites make their directories there, and this host is
                    // isolated, so it is shared with nothing a stage should not reach.
                    sandboxPolicy: canWrite
                        ? {
                              type: 'workspaceWrite',
                              writableRoots: [context.worktreeRoot],
                              networkAccess,
                              excludeTmpdirEnvVar: false,
                              excludeSlashTmp: false,
                          }
                        : { type: 'readOnly', networkAccess },
                    input: [
                        {
                            type: 'text',
                            text: resumed
                                ? resumePrompt(context)
                                : prompt({ stage, context, planPath, learningsPath, title, baseSha, canWrite, schema, resume }),
                            text_elements: [],
                        },
                    ],
                });
                return turnCompleted;
            };

            const ending = await Promise.race([start(), stopped, connection.closed.then(exit => ({ exit }))]);

            if (thrown !== undefined) throw thrown;
            if (stoppedBecause === 'reported') {
                return {
                    result: reported,
                    usage,
                    truncated: false,
                    budgetFailure: overBudget(budgetedInputTokens(usage), stage.maxInputTokens),
                    ...trace(),
                };
            }
            if (stoppedBecause === 'interrupted') return interrupted();
            if (stoppedBecause) {
                return {
                    result: reported ?? (summary ? { summary } : undefined),
                    usage,
                    truncated: true,
                    ...(stoppedBecause === 'silent'
                        ? { engineFailure: `${engineSilent(stage.maxIdleMs)}${lastError ? ` — its last error: ${lastError}` : ''}` }
                        : { budgetFailure }),
                    ...dropped(),
                    ...trace(),
                };
            }
            if (ending === STOPPED) return { truncated: true, ...trace() };
            if ('exit' in ending) {
                return await engineFailed(
                    `the process exited on its own${ending.exit.error ? `: ${ending.exit.error.message}` : ''}${typeof ending.exit.code === 'number' ? `, exit code ${ending.exit.code}` : ''}${ending.exit.signal ? `, signal ${ending.exit.signal}` : ''}`,
                    ending.exit,
                );
            }

            const stopReason = `ended as '${ending.status}'`;
            if (ending.status === 'completed') {
                if (!anyToolSeen) await append('turn.empty', { engineStopReason: stopReason });
                return {
                    result: undefined,
                    usage,
                    truncated: false,
                    budgetFailure: overBudget(budgetedInputTokens(usage), stage.maxInputTokens),
                    engineStopReason: stopReason,
                    ...dropped(),
                    ...trace(),
                };
            }
            // A failed turn includes an account limit, reported here like any other failure.
            const info = ending.error?.codexErrorInfo;
            return {
                ...(await engineFailed(
                    `the turn ${stopReason}: ${ending.error?.message ?? 'no reason given'}${info ? ` (${typeof info === 'string' ? info : JSON.stringify(info)})` : ''}`,
                )),
                engineStopReason: stopReason,
            };
        } catch (err) {
            if (err === RESUME_FAILED) return { truncated: true, resumeFailed: true };
            if (thrown !== undefined) throw thrown;
            return await engineFailed((err as Error).message);
        } finally {
            clearTimeout(wallClock);
            clearTimeout(idle);
            this.interrupts?.signal.removeEventListener('abort', interrupt);
            connection.close();
            await host.unlink(join(context.worktreeRoot, REPORT_RESULT_PATH)).catch(() => {});
            await host.removeTree(join(context.worktreeRoot, SCRATCH_PREFIX)).catch(() => {});
        }
    }
}

const STOPPED = Symbol('stopped');
const RESUME_FAILED = Symbol('resume failed');

/** A tool's input schema without the `$schema` line, which is no part of what the model is shown. */
const inputSchema = (schema: z.ZodTypeAny): unknown => {
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    delete json.$schema;
    return json;
};

const dynamicTools = (schema: z.ZodTypeAny, canWrite: boolean): unknown[] => [
    {
        type: 'function',
        name: REPORT_TOOL,
        description:
            'Report the work you have completed and end the stage. Call this exactly once, only after every change is made and the build passes.',
        inputSchema: inputSchema(schema),
    },
    ...(canWrite
        ? [
              {
                  type: 'function',
                  name: REQUEST_SCOPE_TOOL,
                  description:
                      'Request permission to write a file outside the plan’s files in scope. Explain why the plan did not anticipate it. Use sparingly.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          path: { type: 'string', description: 'Path relative to the worktree root.' },
                          reason: { type: 'string', description: 'Why this file is genuinely part of this card.' },
                      },
                      required: ['path', 'reason'],
                      additionalProperties: false,
                  },
              },
          ]
        : []),
];

const resumePrompt = (context: ToolContext): string =>
    [
        `The daemon restarted and interrupted this stage. The worktree at ${context.worktreeRoot} is as you`,
        `left it, but any command in progress when it stopped may not have finished. Check where your`,
        `last step got to, then carry on with the stage and finish it as you were told to.`,
    ].join('\n');

const prompt = ({
    stage,
    context,
    planPath,
    learningsPath,
    title,
    baseSha,
    canWrite,
    schema,
    resume,
}: Pick<AgentRunInput, 'stage' | 'context' | 'planPath' | 'learningsPath' | 'title' | 'baseSha' | 'resume'> & {
    canWrite: boolean;
    schema: z.ZodTypeAny;
}): string =>
    [
        ...(resume
            ? [
                  `An earlier attempt at this stage was interrupted by a restart, and its uncommitted work is`,
                  `still in the worktree. Check it before building on it.`,
                  '',
              ]
            : []),
        `Card: ${title}`,
        '',
        `Your plan is at ${planPath}. Read it before anything else. Its "Files in scope" is what`,
        `you may change and its "Out of scope" is binding even where you could make the change.`,
        '',
        ...(learningsPath
            ? [
                  `Before you start, also read the project's learnings at ${learningsPath}. They are`,
                  `human-approved guidance for this project — follow them like the plan, not material to weigh.`,
                  '',
              ]
            : []),
        `You are in a git worktree at ${context.worktreeRoot}.`,
        '',
        `\`git diff ${baseSha}\` is the card's whole diff across every stage — this is what the`,
        `verifier measures and what a finding must cite.`,
        '',
        stage.instructions,
        '',
        `Every command and file change is checked before it runs. Run one command at a time with plain`,
        `arguments: no pipes, redirects, chaining or globs. If a call is refused, you will be told why.`,
        '',
        ...(canWrite
            ? [
                  `If the plan's "Files in scope" does not cover a file the work genuinely needs, call`,
                  `${REQUEST_SCOPE_TOOL} with the path and why, rather than working around the gap.`,
                  '',
                  ...(stage.testReportPath !== undefined
                      ? [
                            `A test that no longer belongs gets deleted, not emptied and left as an 'it.skip':`,
                            `this stage's exit condition compares the skipped-test count against the baseline,`,
                            `and a new skip reads as a regression and fails the stage.`,
                            '',
                        ]
                      : []),
                  `Anything you need to generate and inspect but that should not ship goes under`,
                  `${SCRATCH_PREFIX} in the worktree. Everything under it is wiped once the run ends.`,
                  '',
              ]
            : []),
        `When the work is done and the build passes, call ${REPORT_TOOL} with your result. It must satisfy this schema:`,
        JSON.stringify(inputSchema(schema)),
        '',
        'Work first, report last: that call ends the stage at once, and a result describing work you did',
        'not do fails it, because the runner checks the diff and not your summary.',
    ].join('\n');
