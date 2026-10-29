import { Injectable } from 'injectkit';
import { Kysely, type Selectable } from 'kysely';
import { DateTime } from 'luxon';
import type { ChatThreads, DB } from '#modules/data/db.js';

/** The engines a thread can run on, spelled as `StageConfig.adapter` spells them: 'api' is the AI SDK, 'cli' the Claude Agent SDK. */
export type ChatEngineName = 'api' | 'cli';

export interface ChatThread {
    id: string;
    title: string;
    engine: ChatEngineName;
    engineSessionId?: string;
    archivedAt?: DateTime;
    createdAt: DateTime;
    updatedAt: DateTime;
}

const toThread = (row: Selectable<ChatThreads>): ChatThread => ({
    id: String(row.id),
    title: row.title,
    engine: row.engine as ChatEngineName,
    engineSessionId: row.engineSessionId ?? undefined,
    archivedAt: row.archivedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

/**
 * `wilson.chat_threads`. Not project-scoped, unlike every repository that takes `BoardConfig`: a
 * thread can touch several projects (see the migration, `20261029120000_chat.sql`). A thread's
 * `engine` is fixed when it is created; nothing here changes it.
 */
@Injectable()
export class ChatThreadRepository {
    constructor(private readonly db: Kysely<DB>) {}

    async create(title: string, engine: ChatEngineName): Promise<ChatThread> {
        const row = await this.db.insertInto('wilson.chatThreads').values({ title, engine }).returningAll().executeTakeFirstOrThrow();
        return toThread(row);
    }

    async get(id: string): Promise<ChatThread | undefined> {
        const row = await this.db.selectFrom('wilson.chatThreads').selectAll().where('id', '=', id).executeTakeFirst();
        return row && toThread(row);
    }

    /** Threads not archived, most recently active first. */
    async list(): Promise<ChatThread[]> {
        const rows = await this.db
            .selectFrom('wilson.chatThreads')
            .selectAll()
            .where('archivedAt', 'is', null)
            .orderBy('updatedAt', 'desc')
            .orderBy('id', 'desc')
            .execute();
        return rows.map(toThread);
    }

    /** Undefined when there is no such thread. */
    async rename(id: string, title: string): Promise<ChatThread | undefined> {
        const row = await this.db.updateTable('wilson.chatThreads').set({ title }).where('id', '=', id).returningAll().executeTakeFirst();
        return row && toThread(row);
    }

    /** Takes the thread out of {@link list}; its messages stay. Undefined when there is no such thread. */
    async archive(id: string): Promise<ChatThread | undefined> {
        const row = await this.db
            .updateTable('wilson.chatThreads')
            .set({ archivedAt: DateTime.now() })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirst();
        return row && toThread(row);
    }

    /** Record the 'cli' engine's session id, so the next turn resumes that session. */
    async setEngineSessionId(id: string, engineSessionId: string): Promise<void> {
        await this.db.updateTable('wilson.chatThreads').set({ engineSessionId }).where('id', '=', id).execute();
    }
}
