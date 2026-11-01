import { Injectable } from 'injectkit';
import { Kysely, type Selectable } from 'kysely';
import { DateTime, type Duration } from 'luxon';
import type { WilsonChatQuestions, DB } from '#modules/data/db.js';
import type { AskedQuestion, QuestionAnswer } from './chat.questions.js';

export type QuestionStatus = 'pending' | 'answered' | 'dismissed';

export interface PendingQuestion {
    id: string;
    threadId: string;
    /** The 1-4 questions exactly as asked, with their options. */
    questions: AskedQuestion[];
    /** One entry per question, in order. Undefined until answered. */
    answers?: QuestionAnswer[];
    status: QuestionStatus;
    expiresAt: DateTime;
    decidedAt?: DateTime;
    createdAt: DateTime;
}

export interface NewPendingQuestion {
    questions: AskedQuestion[];
    /** How long the person has to answer it. */
    expiresIn: Duration;
}

const toQuestion = (row: Selectable<WilsonChatQuestions>): PendingQuestion => ({
    id: String(row.id),
    threadId: String(row.threadId),
    questions: row.questions as unknown as AskedQuestion[],
    answers: (row.answers as unknown as QuestionAnswer[] | null) ?? undefined,
    status: row.status as QuestionStatus,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt ?? undefined,
    createdAt: row.createdAt,
});

/**
 * `wilson.chat_questions`: the structured questions the chat's agent asked, which only the person's
 * own submission answers. See the migration (`20261031000000_chat_questions.sql`) for the status flow
 * and why this is a sibling table to `ChatPendingActionRepository` rather than a shared abstraction.
 *
 * Every transition out of 'pending' is one conditional UPDATE that matches only a pending question not
 * yet expired, and answers undefined when nothing matched — the same reasoning
 * `ChatPendingActionRepository`'s doc comment gives: that is what makes answering at-most-once without
 * a lock, two submissions of the same question race to the same UPDATE, and only one of them gets the
 * row back. `dismissPending` is the one exception: a message dismisses every pending question on its
 * thread regardless of expiry, since a lapsed question is dismissed just as happily as a live one.
 */
@Injectable()
export class ChatQuestionRepository {
    constructor(private readonly db: Kysely<DB>) {}

    async ask(threadId: string, question: NewPendingQuestion): Promise<PendingQuestion> {
        const row = await this.db
            .insertInto('wilson.chatQuestions')
            .values({
                threadId: BigInt(threadId),
                questions: JSON.stringify(question.questions),
                expiresAt: DateTime.now().plus(question.expiresIn),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        return toQuestion(row);
    }

    async get(id: string): Promise<PendingQuestion | undefined> {
        const row = await this.db.selectFrom('wilson.chatQuestions').selectAll().where('id', '=', BigInt(id)).executeTakeFirst();
        return row && toQuestion(row);
    }

    /** A thread's questions, oldest first, whatever their status. */
    async forThread(threadId: string): Promise<PendingQuestion[]> {
        const rows = await this.db
            .selectFrom('wilson.chatQuestions')
            .selectAll()
            .where('threadId', '=', BigInt(threadId))
            .orderBy('id')
            .execute();
        return rows.map(toQuestion);
    }

    /** Answer a pending, unexpired question once. Undefined when it was not one (already decided, or expired). */
    async answer(id: string, answers: QuestionAnswer[]): Promise<PendingQuestion | undefined> {
        const now = DateTime.now();
        const row = await this.db
            .updateTable('wilson.chatQuestions')
            .set({ status: 'answered', answers: JSON.stringify(answers), decidedAt: now })
            .where('id', '=', BigInt(id))
            .where('status', '=', 'pending')
            .where('expiresAt', '>', now)
            .returningAll()
            .executeTakeFirst();
        return row && toQuestion(row);
    }

    /**
     * Dismiss every pending question on a thread — an ordinary message on it supersedes whatever it
     * had not yet answered. No expiry predicate: a lapsed question is dismissed just as happily as a
     * live one.
     */
    async dismissPending(threadId: string): Promise<PendingQuestion[]> {
        const rows = await this.db
            .updateTable('wilson.chatQuestions')
            .set({ status: 'dismissed', decidedAt: DateTime.now() })
            .where('threadId', '=', BigInt(threadId))
            .where('status', '=', 'pending')
            .returningAll()
            .execute();
        return rows.map(toQuestion);
    }
}
