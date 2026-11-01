import { Injectable } from 'injectkit';
import { ToolLoopAgent, hasToolCall, stepCountIs } from 'ai';
import type { z } from 'zod';
import { overBudget, tokenBudgetExceeded, wallClockExceeded } from './budget.js';
import { buildRunTrace } from './run.trace.js';
import { compactMessages } from './compact.messages.js';
import { ModelRegistry } from './model.registry.js';
import { StageAgent, type AgentRunInput, type AgentRunOutput } from './stage.agent.js';
import { buildTools, REPORT_TOOL } from './tools/index.js';

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
        const agent = new ToolLoopAgent({
            model: this.models.resolve(stage.provider, stage.model),
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
            tools: buildTools(context, resultSchema as z.ZodTypeAny, stage.worktree),
            ...(stage.tools ? { activeTools: stage.tools as never } : {}),
            // The loop ends when the agent says it is finished, when it runs out of steps, or when it
            // exceeds its input token budget.
            stopWhen: [hasToolCall(REPORT_TOOL), stepCountIs(stage.maxSteps), tokenBudgetExceeded(stage.maxInputTokens)],
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
                ].join('\n'),
                abortSignal: AbortSignal.timeout(stage.maxWallClockMs),
            });

            const inputTokens = run.usage?.inputTokens;
            const output: AgentRunOutput = {
                result: reportedResult(run.steps),
                usage: { inputTokens, outputTokens: run.usage?.outputTokens },
                truncated: run.steps.length >= stage.maxSteps,
                budgetFailure: overBudget(inputTokens, stage.maxInputTokens),
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
const reportedResult = (steps: readonly { toolCalls?: readonly { toolName: string; input?: unknown }[] }[]): unknown => {
    for (const step of [...steps].reverse()) {
        const call = step.toolCalls?.find(c => c.toolName === REPORT_TOOL);
        if (call) return call.input;
    }
    return undefined;
};
