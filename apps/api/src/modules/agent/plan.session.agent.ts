import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { subscriptionEnv } from './cli.stage.agent.js';

/**
 * Feeds `query()`'s `AsyncIterable` prompt one user turn at a time, blocking between turns rather
 * than closing — the mechanism that keeps a single engine session open across many
 * `PlanSessionAgent.turn()` calls instead of starting a fresh `query()`, and therefore a fresh
 * model context, per message. A message pushed while nothing is waiting queues; a message pushed
 * while the iterator is parked resolves it directly.
 */
class TurnInbox implements AsyncIterable<SDKUserMessage> {
    private readonly pending: SDKUserMessage[] = [];
    private waiting?: (message: SDKUserMessage) => void;

    push(text: string): void {
        const message: SDKUserMessage = {
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
        };
        if (this.waiting) {
            const resolve = this.waiting;
            this.waiting = undefined;
            resolve(message);
        } else {
            this.pending.push(message);
        }
    }

    async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        for (;;) {
            const next = this.pending.shift();
            if (next) {
                yield next;
                continue;
            }
            yield await new Promise<SDKUserMessage>(resolve => {
                this.waiting = resolve;
            });
        }
    }
}

export interface PlanSessionOptions {
    /** Absolute path to the throwaway plan worktree — `PlanService.open`'s `worktreePath`, or the
     * same deterministic path computed again for a card whose worktree `open` already cut. */
    worktreeRoot: string;
    /** The `planning` stage's own model, from `stages.yaml` (`ModelRegistry`'s config source, not a
     * literal this file pins). */
    model: string;
    /** The engine's own session id to resume — set only when this agent is rehydrating a
     * conversation `runner.plan_turns` already has turns for, never for a brand-new one. */
    resume?: string;
}

/**
 * One live planning conversation: a single `query()` call whose prompt is a {@link TurnInbox}
 * rather than a plain string, so it stays open for the session's whole lifetime and every
 * `turn()` continues the same model context instead of starting a fresh one. That is the one thing
 * `cli.stage.agent.ts`'s single-shot `prompt: string` cannot express — that adapter's class doc
 * comment declines exactly this rework for a narrower defect (card 0097), and this file is where
 * that rework actually happens, for the one caller that genuinely needs it.
 *
 * Carries none of that adapter's `report_result`/`request_scope`/delete tools, its `ScopeGuard`
 * wiring, or its step/wall-clock/context budget: a conversation has no verdict to report and no
 * exit condition to police (this card's Constraints). `bypassPermissions` stands in for the
 * operator who would otherwise be sitting at the terminal approving each tool call interactively —
 * exactly how `wilson card plan` runs today — because there is no human on the other end of an HTTP
 * turn to ask.
 */
export class PlanSessionAgent {
    private readonly inbox = new TurnInbox();
    private readonly stream: Query;
    private readonly iterator: AsyncIterator<SDKMessage>;

    /** The engine's own session id, once the stream has reported one. Read by the caller after a
     * turn completes and persisted alongside that turn (`plan.turn.repository.ts`), so a later
     * process can resume this exact conversation via {@link PlanSessionOptions.resume}. */
    sessionId: string | undefined;

    constructor(options: PlanSessionOptions) {
        this.stream = query({
            prompt: this.inbox,
            options: {
                cwd: options.worktreeRoot,
                model: options.model,
                // Never 'default': that prompts for every tool call, and there is no terminal on
                // the other end of this session to answer the prompt — see the class doc comment.
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
                // Same reasoning as `cli.stage.agent.ts`'s identical pair: pins the tool surface to
                // this call's own config rather than whatever happens to be in the host machine's
                // `~/.claude` (settings, MCP servers) at the moment it runs.
                settingSources: [],
                strictMcpConfig: true,
                env: subscriptionEnv(),
                ...(options.resume ? { resume: options.resume } : {}),
            },
        });
        this.iterator = this.stream[Symbol.asyncIterator]();
    }

    /**
     * Push one user turn and yield the assistant's reply as it is produced, one chunk per
     * completed content block — the granularity the engine itself emits them on the stream (see
     * `SDKAssistantMessage`'s own doc comment: "one assistant message per completed content
     * block"). Ends on the CLI's own turn-complete signal, the `result` message ("the CLI emits
     * exactly one result message per turn... treat it as the turn-complete signal").
     */
    async *turn(text: string): AsyncGenerator<string> {
        this.inbox.push(text);
        for (;;) {
            const next = await this.iterator.next();
            if (next.done) return;
            const message = next.value;
            if ('session_id' in message && message.session_id) {
                this.sessionId = message.session_id;
            }
            if (message.type === 'assistant') {
                const chunk = message.message.content.map(part => (part.type === 'text' ? part.text : '')).join('');
                if (chunk) yield chunk;
            }
            if (message.type === 'result') return;
        }
    }

    /**
     * Tears the engine process down. Called from `PlanService.close` and from
     * `plan.session.registry.ts`'s idle timeout alike; the transcript in `runner.plan_turns`
     * outlives it either way, which is exactly what lets a later turn resume it.
     */
    dispose(): void {
        void this.stream.return(undefined).catch(() => {});
    }
}
