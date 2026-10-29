import { DateTime } from 'luxon';
const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * A project's human-approved learnings document (card 0239) — the operator's surface, cloned from
 * `stages.ck`'s `StageConfigDocument` shape: `wilson learnings show|edit|set|versions` all call
 * here. Agents never read this document through this API; card 0244 materializes it for a stage
 * agent a different way, and no agent runs with this API reachable as a tool in the first place
 * (PROJECT.md decision 6, decision 8's own reasoning — see `stages.ck`'s comment for the fuller
 * argument, which applies here unchanged).
 *
 * Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session
 * or a `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session
 * or key does. Anything without a credential gets 401 before a handler runs.
 *
 * Unlike stage config, a learnings document has no schema to validate — `markdown` is free text, so
 * there is no `400` here, and a project with no document yet is not a failure either: `GET
 * /api/learnings` answers with an empty document rather than a `404`, since an operator retiring
 * every learning at once (an empty save) must read back the same way a project that never saved one
 * does.
 * generated from [LearningsDocument](../../../../apps/api/data/contracts/learnings.ck)
 */
export interface LearningsDocument {
    id?: string;
    markdown: string;
    message: string;
    createdAt?: DateTime;
}

/** Rehydrates every wire-encoded scalar in a LearningsDocument into its runtime type. Mutates and returns `raw`. */
export function reviveLearningsDocument(raw: LearningsDocument): LearningsDocument {
    const __o0 = raw as unknown as Record<string, unknown>;
    if (__o0['createdAt'] != null) {
        __o0['createdAt'] = __dt(__o0['createdAt'], 'LearningsDocument.createdAt');
    }
    return raw;
}

/**
 * `message` optional, same reasoning as `SetStageConfigRequest`: `wilson learnings edit` has no
 * commit-message prompt the way `git commit` does, and a default ("Edited learnings") beats forcing
 * one.
 * generated from [SetLearningsRequest](../../../../apps/api/data/contracts/learnings.ck)
 */
export interface SetLearningsRequest {
    markdown: string;
    message?: string;
}

/**
 * generated from [LearningsVersion](../../../../apps/api/data/contracts/learnings.ck)
 */
export interface LearningsVersion {
    id: string;
    message: string;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a LearningsVersion into its runtime type. Mutates and returns `raw`. */
export function reviveLearningsVersion(raw: LearningsVersion): LearningsVersion {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'LearningsVersion.createdAt');
    return raw;
}

/**
 * generated from [LearningsVersionsQuery](../../../../apps/api/data/contracts/learnings.ck)
 */
export interface LearningsVersionsQuery {
    limit?: number;
}
