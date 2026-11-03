import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { ServerKitContext } from '@maroonedsoftware/koa';
import { requireSession } from '#modules/authentication/request.session.js';
import { BoardConfig } from '#modules/board/board.config.js';
import type { CodeFilePage, CodeListQuery, CodeListing, CodeReadQuery, CodeSearchQuery, CodeSearchResult } from '../../generated/code.js';
import { CodeReadRepository, type CodeReadOperation } from './code.read.repository.js';
import { CodeReader, CodeRefusal } from './code.reader.js';

/**
 * Run one read of a project's code, leaving a record of it or of its refusal. A read whose record
 * cannot be written fails rather than returning code, so the record goes first.
 */
export const auditedRead = async <T extends { commit: string }>(
    reads: CodeReadRepository,
    record: { project: string; operation: CodeReadOperation; subject: string; path?: string; ref?: string; pattern?: string },
    run: () => Promise<T>,
): Promise<T> => {
    let result: T;
    try {
        result = await run();
    } catch (err) {
        if (err instanceof CodeRefusal) {
            await reads.record({ ...record, commit: err.commit, outcome: 'refused', reason: err.reason });
            throw httpError(400).withDetails({ reason: err.reason });
        }
        await reads.record({ ...record, outcome: 'failed', reason: err instanceof Error ? err.message : String(err) });
        throw err;
    }

    await reads.record({ ...record, commit: result.commit, outcome: 'read' });
    return result;
};

/**
 * `code.ck`: read the code of whichever project the request is in, leaving a record of each read.
 *
 * A read whose record cannot be written fails rather than returning code, which is why the record
 * goes first and the result only comes back after it.
 *
 * Takes `ServerKitContext` for the session's subject, so the container wiring test exempts it, as it
 * does `CurrentSessionService`. `ChatCatalog.run` supplies one for a chat turn's own scope.
 */
@Injectable()
export class CodeService {
    constructor(
        private readonly context: ServerKitContext,
        private readonly board: BoardConfig,
        private readonly reads: CodeReadRepository,
    ) {}

    list(query: CodeListQuery): Promise<CodeListing> {
        return this.audited('list', query, reader => reader.list(query));
    }

    read(query: CodeReadQuery): Promise<CodeFilePage> {
        return this.audited('read', query, reader => reader.read(query));
    }

    search(query: CodeSearchQuery): Promise<CodeSearchResult> {
        return this.audited('search', query, reader => reader.search(query));
    }

    private audited<T extends { commit: string }>(
        operation: CodeReadOperation,
        query: { path?: string; ref?: string; pattern?: string },
        run: (reader: CodeReader) => Promise<T>,
    ): Promise<T> {
        // `requirePolicy` has already refused a request with no session; this only narrows the type.
        const { subject } = requireSession(this.context);
        return auditedRead(this.reads, { project: this.board.project, operation, subject, ...query }, () => run(new CodeReader(this.board.codeRoot)));
    }
}
