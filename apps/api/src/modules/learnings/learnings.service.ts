import { Injectable } from 'injectkit';
import type { LearningsDocument, LearningsVersion, LearningsVersionsQuery, SetLearningsRequest } from '../../generated/learnings.js';
import { LearningsStore, type LearningsDocument as StoredDocument } from './learnings.store.js';

/** The most versions one request returns, and the default — the same numbers `StageConfigService` uses. */
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 200;

/** What a save with no message of its own is recorded as. */
const DEFAULT_MESSAGE = 'Edited learnings';

/** The document a project with no saved row answers with — empty, not a 404. */
const EMPTY_DOCUMENT: LearningsDocument = { markdown: '', message: '' };

/**
 * The learnings document's read and write surface — the service `learnings.ck`'s operations bind
 * to, over `LearningsStore`.
 *
 * Thin like `StageConfigService` beside it, with one deliberate difference: a stage config with no
 * row is a fact worth a 404 (nothing configured to dispatch against), but a project with no
 * learnings yet is not a failure — `get` answers with an empty document (AC3) rather than refusing,
 * and `set` never refuses either, since `markdown` is free text with no schema to fail.
 */
@Injectable()
export class LearningsService {
    constructor(private readonly learnings: LearningsStore) {}

    async get(): Promise<LearningsDocument> {
        const document = await this.learnings.read();
        return document ? toContract(document) : EMPTY_DOCUMENT;
    }

    async set(body: SetLearningsRequest): Promise<LearningsDocument> {
        return toContract(await this.learnings.save(body.markdown, body.message?.trim() || DEFAULT_MESSAGE));
    }

    async versions(query: LearningsVersionsQuery): Promise<LearningsVersion[]> {
        const limit = Math.min(query.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
        const versions = await this.learnings.versions(limit);
        return versions.map(version => ({ id: version.id, message: version.message, createdAt: version.createdAt }));
    }
}

const toContract = (document: StoredDocument): LearningsDocument => ({
    id: document.id,
    markdown: document.markdown,
    message: document.message,
    createdAt: document.createdAt,
});
