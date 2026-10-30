import { Injectable } from 'injectkit';
import { Kysely, sql, type Selectable } from 'kysely';
import type { DateTime } from 'luxon';
import type { WilsonChatMessages, DB } from '#modules/data/db.js';

export type ChatRole = 'user' | 'assistant';

/** One catalog operation the agent ran while answering, as the chat shows it. */
export interface ChatOperation {
    /** The catalog operation's name, e.g. `list_cards`. */
    name: string;
    arguments: unknown;
    /** The project it ran in, when it named one. */
    project?: string;
    /** False when the operation threw; the agent was told why. */
    ok: boolean;
}

export interface ChatMessage {
    threadId: string;
    seq: number;
    role: ChatRole;
    content: string;
    operations: ChatOperation[];
    /** What the answer offered to ask next; empty on a person's message. */
    suggestions: string[];
    /** The 'api' engine's own record of the turn, opaque here; undefined for a person's message and for 'cli'. */
    engineMessages?: unknown;
    createdAt: DateTime;
}

export interface NewChatMessage {
    role: ChatRole;
    content: string;
    operations?: ChatOperation[];
    suggestions?: string[];
    engineMessages?: unknown;
}

const toMessage = (row: Selectable<WilsonChatMessages>): ChatMessage => ({
    threadId: String(row.threadId),
    seq: row.seq,
    role: row.role as ChatRole,
    content: row.content,
    operations: row.operations as unknown as ChatOperation[],
    suggestions: row.suggestions as unknown as string[],
    engineMessages: row.engineMessages ?? undefined,
    createdAt: row.createdAt,
});

/**
 * `wilson.chat_messages`, append-only and numbered per thread — `PlanTurnRepository`'s shape, keyed
 * by thread rather than by card.
 */
@Injectable()
export class ChatMessageRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /**
     * Append one message, assigning it the next `seq` for its thread, and move the thread's
     * `updated_at` with it so the thread list reads most recent first.
     *
     * The same advisory lock `PlanTurnRepository.append` takes, keyed by thread: a thread's first
     * message has no row to lock with `forUpdate`, and two appends racing for the same `seq` would
     * otherwise collide on the primary key.
     */
    async append(threadId: string, message: NewChatMessage): Promise<ChatMessage> {
        return this.db.transaction().execute(async trx => {
            await sql`select pg_advisory_xact_lock(hashtext('chat'), hashtext(${threadId}))`.execute(trx);

            const last = await trx
                .selectFrom('wilson.chatMessages')
                .select('seq')
                .where('threadId', '=', BigInt(threadId))
                .orderBy('seq', 'desc')
                .limit(1)
                .executeTakeFirst();

            const row = await trx
                .insertInto('wilson.chatMessages')
                .values({
                    threadId: BigInt(threadId),
                    seq: (last?.seq ?? 0) + 1,
                    role: message.role,
                    content: message.content,
                    operations: JSON.stringify(message.operations ?? []),
                    suggestions: JSON.stringify(message.suggestions ?? []),
                    engineMessages: message.engineMessages === undefined ? null : JSON.stringify(message.engineMessages),
                })
                .returningAll()
                .executeTakeFirstOrThrow();

            await trx.updateTable('wilson.chatThreads').set({ updatedAt: row.createdAt }).where('id', '=', BigInt(threadId)).execute();

            return toMessage(row);
        });
    }

    /** A thread's messages with `seq` strictly greater than `afterSeq`, in order; 0 for all of them. */
    async since(threadId: string, afterSeq = 0): Promise<ChatMessage[]> {
        const rows = await this.db
            .selectFrom('wilson.chatMessages')
            .selectAll()
            .where('threadId', '=', BigInt(threadId))
            .where('seq', '>', afterSeq)
            .orderBy('seq')
            .execute();
        return rows.map(toMessage);
    }
}
