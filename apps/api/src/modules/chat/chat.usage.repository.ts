import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import type { ChatTurnOutput } from './chat.engine.js';
import type { ChatEngineName } from './chat.thread.repository.js';

export interface NewChatTurnUsage {
    engine: ChatEngineName;
    model: string;
    usage: NonNullable<ChatTurnOutput['usage']>;
    /** The engine account it was spent on, absent for an engine that signs in with none. */
    account?: string;
}

/** `wilson.chat_turn_usage`: what each chat turn cost, silent turns included, since those store no message. */
@Injectable()
export class ChatUsageRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Record one turn's cost against its thread. */
    async record(threadId: string, { engine, model, usage, account }: NewChatTurnUsage): Promise<void> {
        await this.db
            .insertInto('wilson.chatTurnUsage')
            .values({
                threadId: BigInt(threadId),
                engine,
                model,
                inputTokens: usage.inputTokens ?? null,
                cachedInputTokens: usage.cachedInputTokens ?? null,
                outputTokens: usage.outputTokens,
                account: account ?? null,
            })
            .execute();
    }
}
