import { Injectable } from 'injectkit';
import { Kysely, type Selectable } from 'kysely';
import { DateTime, type Duration } from 'luxon';
import type { ChatPendingActions, DB } from '#modules/data/db.js';

export type PendingActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'declined';

export interface PendingAction {
    id: string;
    threadId: string;
    /** The project the operation runs in; undefined for one that names none. */
    project?: string;
    /** A catalog operation's name. */
    operation: string;
    /** Exactly what the operation will be called with. */
    arguments: unknown;
    /** The sentence the person is asked to confirm. */
    summary: string;
    status: PendingActionStatus;
    result?: unknown;
    error?: string;
    expiresAt: DateTime;
    decidedAt?: DateTime;
    createdAt: DateTime;
}

export interface NewPendingAction {
    project?: string;
    operation: string;
    arguments: unknown;
    summary: string;
    /** How long the person has to confirm it. */
    expiresIn: Duration;
}

const toAction = (row: Selectable<ChatPendingActions>): PendingAction => ({
    id: String(row.id),
    threadId: String(row.threadId),
    project: row.project ?? undefined,
    operation: row.operation,
    arguments: row.arguments,
    summary: row.summary,
    status: row.status as PendingActionStatus,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt ?? undefined,
    createdAt: row.createdAt,
});

/**
 * `wilson.chat_pending_actions`: the changes the chat's agent proposed, which only the person's
 * decision runs. See the migration (`20261029120000_chat.sql`) for the status flow.
 *
 * Every transition out of 'pending' is one conditional UPDATE that matches only a pending action
 * not yet expired, and answers undefined when nothing matched. That is what makes a decision
 * at-most-once without a lock: two confirms of the same action race to the same UPDATE, and only one
 * of them gets the row back.
 */
@Injectable()
export class ChatPendingActionRepository {
    constructor(private readonly db: Kysely<DB>) {}

    async propose(threadId: string, action: NewPendingAction): Promise<PendingAction> {
        const row = await this.db
            .insertInto('wilson.chatPendingActions')
            .values({
                threadId,
                project: action.project ?? null,
                operation: action.operation,
                arguments: JSON.stringify(action.arguments),
                summary: action.summary,
                expiresAt: DateTime.now().plus(action.expiresIn),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        return toAction(row);
    }

    async get(id: string): Promise<PendingAction | undefined> {
        const row = await this.db.selectFrom('wilson.chatPendingActions').selectAll().where('id', '=', id).executeTakeFirst();
        return row && toAction(row);
    }

    /** A thread's actions, oldest first, whatever their status. */
    async forThread(threadId: string): Promise<PendingAction[]> {
        const rows = await this.db.selectFrom('wilson.chatPendingActions').selectAll().where('threadId', '=', threadId).orderBy('id').execute();
        return rows.map(toAction);
    }

    /**
     * Confirm: move a pending, unexpired action to 'running', before its operation is called.
     * Undefined when it was not pending (already decided, or running) or has expired — the caller
     * must not run it then.
     */
    async claim(id: string): Promise<PendingAction | undefined> {
        return this.decide(id, 'running');
    }

    /** Decline a pending, unexpired action. Undefined when it was not one. */
    async decline(id: string): Promise<PendingAction | undefined> {
        return this.decide(id, 'declined');
    }

    /** Record how a claimed action's operation went. Only a 'running' action can finish. */
    async finish(id: string, outcome: { result: unknown } | { error: string }): Promise<PendingAction | undefined> {
        const row = await this.db
            .updateTable('wilson.chatPendingActions')
            .set(
                'error' in outcome
                    ? { status: 'failed', error: outcome.error }
                    : { status: 'done', result: outcome.result === undefined ? null : JSON.stringify(outcome.result) },
            )
            .where('id', '=', id)
            .where('status', '=', 'running')
            .returningAll()
            .executeTakeFirst();
        return row && toAction(row);
    }

    private async decide(id: string, status: 'running' | 'declined'): Promise<PendingAction | undefined> {
        const now = DateTime.now();
        const row = await this.db
            .updateTable('wilson.chatPendingActions')
            .set({ status, decidedAt: now })
            .where('id', '=', id)
            .where('status', '=', 'pending')
            .where('expiresAt', '>', now)
            .returningAll()
            .executeTakeFirst();
        return row && toAction(row);
    }
}
