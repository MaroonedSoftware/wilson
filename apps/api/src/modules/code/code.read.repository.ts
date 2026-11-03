import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

export type CodeReadOperation = 'list' | 'read' | 'search';
export type CodeReadOutcome = 'read' | 'refused' | 'failed';

export interface NewCodeRead {
    project: string;
    operation: CodeReadOperation;
    path?: string;
    /** The ref as it was asked for, whatever it turned out to be. */
    ref?: string;
    /** The commit that ref resolved to, once it had. */
    commit?: string;
    pattern?: string;
    /** Who asked: the session's subject. */
    subject: string;
    outcome: CodeReadOutcome;
    /** Why a read was refused or failed. */
    reason?: string;
}

/** Postgres text cannot hold a NUL, and a path refused for containing one still gets its record. */
const storable = (text: string | undefined): string | null => text?.replaceAll('\0', '�') ?? null;

/**
 * `wilson.code_reads`: every read of a project's code and every refusal of one. See the migration
 * (`20261103120000_code_reads.sql`) for why this is not `wilson.card_events`. Append-only, so there
 * is one method.
 */
@Injectable()
export class CodeReadRepository {
    constructor(private readonly db: Kysely<DB>) {}

    async record(read: NewCodeRead): Promise<void> {
        await this.db
            .insertInto('wilson.codeReads')
            .values({
                project: read.project,
                operation: read.operation,
                path: storable(read.path),
                ref: storable(read.ref),
                commitSha: read.commit ?? null,
                pattern: storable(read.pattern),
                subject: read.subject,
                outcome: read.outcome,
                reason: storable(read.reason),
            })
            .execute();
    }
}
