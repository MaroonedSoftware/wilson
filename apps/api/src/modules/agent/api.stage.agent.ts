import { Injectable } from 'injectkit';
import { ToolLoopAgent, hasToolCall, stepCountIs } from 'ai';
import type { z } from 'zod';
import { budgetedInputTokens, overBudget, stageUsageOf, tokenBudgetExceeded, wallClockExceeded } from './budget.js';
import { buildRunTrace } from './run.trace.js';
import { compactMessages } from './compact.messages.js';
import { ModelRegistry } from './model.registry.js';
import { StageAgent, type AgentRunInput, type AgentRunOutput } from './stage.agent.js';
import { BLOCKED_TOOL, blockedGuidance, buildTools, REPORT_TOOL } from './tools/index.js';
import { BlockedReportSchema } from './blocked.report.js';
import { RepeatedCallWatch, describeRepeatedCall, type RepeatedCall } from './repeated.call.js';
import { modelOf } from '#modules/stages/stage.config.js';

/**
 * Runs a stage through the AI SDK against a provider API key.
 *
 * The original path, unchanged in behaviour: our own tools, our own loop, our own compaction. It
 * bills per token and stops working when the balance does — which is why `CliStageAgent` exists
 * beside it.
 *
 * **`stage.instructions` (board config) must never name a tool, bare or qualified.** Config
 * cannot know which adapter will run a given stage — `adapter` is a field on the very same stage
 * config, and can change — and this adapter's tools are named differently from `cli`'s (this
 * one's `delete` is literally that; `cli`'s is MCP-qualified). This adapter's own tools already
 * carry their real names and descriptions in the schema the model sees (`buildTools`), which is
 * enough on its own; the only extra guidance appended below is a stage-specific consequence the
 * generic tool description has no way to state (card 0097).
 */
@Injectable()
export class ApiStageAgent extends StageAgent {
    constructor(private readonly models: ModelRegistry) {
        super();
    }

    async run({ stage, context, planPath, learningsPath, title, resultSchema, baseSha }: AgentRunInput): Promise<AgentRunOutput> {
        const canWrite = stage.worktree === 'rw';
        // Same signal `TestingVerifier.checkCounts` itself keys off — see the matching comment in
        // `cli.stage.agent.ts`. Gates the "don't leave an it.skip behind" warning below, which only
        // means something where a stage actually compares test counts against a baseline.
        const checksTestCounts = stage.testReportPath !== undefined;
        const canAsk = !stage.step;
        const agent = new ToolLoopAgent({
            model: this.models.resolve(stage.provider, modelOf(stage)),
            instructions: [
                stage.instructions,
                ...(canWrite && checksTestCounts
                    ? [
                          '',
                          `A test that no longer belongs gets deleted, not emptied and left as an 'it.skip': this`,
                          `stage's exit condition compares the skipped-test count against the baseline, and a`,
                          `new skip reads as a regression and fails the stage.`,
                      ]
                    : []),
            ].join('\n'),
            tools: buildTools(context, resultSchema as z.ZodTypeAny, stage.worktree, canAsk),
            // A lane's `tools` narrows how it works. Being able to stop and ask is not part of that.
            ...(stage.tools ? { activeTools: [...stage.tools, ...(canAsk ? [BLOCKED_TOOL] : [])] as never } : {}),
            // The loop ends when the agent says it is finished or has a question, when it runs out of
            // steps, when it exceeds its input token budget, or when it keeps making the same call.
            stopWhen: [
                hasToolCall(REPORT_TOOL),
                hasToolCall(BLOCKED_TOOL),
                stepCountIs(stage.maxSteps),
                tokenBudgetExceeded(stage.maxInputTokens),
                ({ steps }) => repeatedCallIn(steps) !== undefined,
            ],
            maxOutputTokens: stage.maxOutputTokens,
            // Without this the conversation grows until the provider refuses it outright.
            prepareStep: ({ messages }) => ({ messages: compactMessages(messages) }),
        });

        // A wall-clock abort throws rather than resolving, and it must fail the stage through the
        // normal exit-condition path rather than as an unhandled error the job runner has to catch.
        try {
            const run = await agent.generate({
                prompt: [
                    `Card: ${title}`,
                    '',
                    `Your plan is at ${planPath}. Read it with the read tool before doing anything else — pass that`,
                    `path exactly as written. It is the contract for this card: its "Files in scope" is what you may`,
                    `change, and its "Out of scope" is binding even where you could technically make the change.`,
                    '',
                    ...(learningsPath
                        ? [
                              `Before you start, also read the project's learnings at ${learningsPath} with the read tool.`,
                              `They are human-approved guidance for this project — follow them like the plan, not material`,
                              `to weigh.`,
                              '',
                          ]
                        : []),
                    `You are working in a git worktree at ${context.worktreeRoot}. Every other tool path is relative to it.`,
                    '',
                    `\`git diff ${baseSha}\` is the card's whole diff across every stage — this is what the`,
                    `verifier measures and what a finding must cite.`,
                    '',
                    'Implement the plan, then return the structured result.',
                    ...(canAsk ? ['', ...blockedGuidance(BLOCKED_TOOL)] : []),
                ].join('\n'),
                abortSignal: AbortSignal.timeout(stage.maxWallClockMs),
            });

            const usage = stageUsageOf(run.usage);
            const result = reportedResult(run.steps);
            // A stage that both reported and asked in one step said it was finished, and the verifier
            // judges that. A question that did not parse has nobody to reach.
            const blocked = result === undefined ? BlockedReportSchema.safeParse(calledWith(run.steps, BLOCKED_TOOL)).data : undefined;
            // A stage that reported or asked in that same step stopped for that reason, not this one.
            const repeated = result === undefined && !blocked ? repeatedCallIn(run.steps) : undefined;
            const output: AgentRunOutput = {
                result,
                ...(blocked ? { blocked } : {}),
                ...(repeated ? { loopFailure: describeRepeatedCall(repeated) } : {}),
                usage,
                truncated: run.steps.length >= stage.maxSteps || repeated !== undefined,
                budgetFailure: overBudget(budgetedInputTokens(usage), stage.maxInputTokens),
                trace: buildRunTrace(readCalls(run.steps), run.text),
            };
            return output;
        } catch (err) {
            if ((err as { name?: string }).name === 'AbortError') {
                return { truncated: true, budgetFailure: wallClockExceeded(stage.maxWallClockMs) };
            }
            throw err;
        }
    }
}

/** This adapter's read tools, as `file.tools.ts` and `search.tools.ts` name them. */
const READ_TOOLS = ['read', 'grep', 'glob'];

/** This adapter's tools that change the tree. Each answers with a string starting `error:` when it did not. */
const WRITE_TOOLS = ['write', 'edit', 'delete'];

interface RepeatableStep {
    toolCalls?: readonly { toolName: string; input?: unknown }[];
    toolResults?: readonly { toolName: string; input?: unknown; output?: unknown }[];
}

/**
 * The call a run has repeated too often, if it has, replayed from its steps. Those are all a `stopWhen`
 * is given, and a step's results come after its calls, as they did when it ran. A result is left out
 * of `toolResults` altogether when its tool threw, so one that is here only has its text to fail by.
 */
const repeatedCallIn = (steps: readonly RepeatableStep[]): RepeatedCall | undefined => {
    const watch = new RepeatedCallWatch();
    for (const step of steps) {
        for (const call of step.toolCalls ?? []) {
            // Reporting and asking end the stage, so neither can be what it is stuck on.
            if (call.toolName !== REPORT_TOOL && call.toolName !== BLOCKED_TOOL) watch.observe(call.toolName, call.input);
        }
        for (const { toolName, input, output } of step.toolResults ?? []) {
            if (WRITE_TOOLS.includes(toolName) && !(typeof output === 'string' && output.startsWith('error:'))) watch.wrote(toolName, input);
        }
    }
    return watch.loop;
};

/** One entry per read tool call across a run's steps, for its trace. */
const readCalls = (steps: readonly { toolCalls?: readonly { toolName: string; input?: unknown }[] }[]): (string | undefined)[] =>
    steps
        .flatMap(step => step.toolCalls ?? [])
        .filter(call => READ_TOOLS.includes(call.toolName))
        .map(call => (call.input as { path?: string } | undefined)?.path);

/**
 * The agent's report, read back off the step where it called the report tool.
 *
 * Absent when the agent never reported — which is itself a signal, since a stage that did not say
 * it had finished did not finish.
 */
const reportedResult = (steps: readonly { toolCalls?: readonly { toolName: string; input?: unknown }[] }[]): unknown =>
    calledWith(steps, REPORT_TOOL);

/** The input of the last call to `tool` across a run's steps, if it was called at all. */
const calledWith = (steps: readonly { toolCalls?: readonly { toolName: string; input?: unknown }[] }[], tool: string): unknown => {
    for (const step of [...steps].reverse()) {
        const call = step.toolCalls?.find(c => c.toolName === tool);
        if (call) return call.input;
    }
    return undefined;
};
