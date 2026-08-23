import { Injectable } from 'injectkit';
import { ToolLoopAgent, hasToolCall, stepCountIs } from 'ai';
import type { z } from 'zod';
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
 */
@Injectable()
export class ApiStageAgent extends StageAgent {
    constructor(private readonly models: ModelRegistry) {
        super();
    }

    async run({ stage, context, planPath, title, resultSchema }: AgentRunInput): Promise<AgentRunOutput> {
        const agent = new ToolLoopAgent({
            model: this.models.resolve(stage.provider, stage.model),
            instructions: stage.instructions,
            tools: buildTools(context, resultSchema as z.ZodTypeAny, stage.worktree),
            ...(stage.tools ? { activeTools: stage.tools as never } : {}),
            // The loop ends when the agent says it is finished, or when it runs out of steps.
            stopWhen: [hasToolCall(REPORT_TOOL), stepCountIs(stage.maxSteps)],
            maxOutputTokens: stage.maxOutputTokens,
            // Without this the conversation grows until the provider refuses it outright.
            prepareStep: ({ messages }) => ({ messages: compactMessages(messages) }),
        });

        const run = await agent.generate({
            prompt: [
                `Card: ${title}`,
                '',
                `Your plan is at ${planPath}. Read it with the read tool before doing anything else — pass that`,
                `path exactly as written. It is the contract for this card: its "Files in scope" is what you may`,
                `change, and its "Out of scope" is binding even where you could technically make the change.`,
                '',
                `You are working in a git worktree at ${context.worktreeRoot}. Every other tool path is relative to it.`,
                '',
                'Implement the plan, then return the structured result.',
            ].join('\n'),
        });

        return {
            result: reportedResult(run.steps),
            usage: { inputTokens: run.usage?.inputTokens, outputTokens: run.usage?.outputTokens },
            truncated: run.steps.length >= stage.maxSteps,
        };
    }
}

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
