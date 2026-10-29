/**
 * One stored document. `yaml` is the text verbatim, comments included — the document is the config,
 * not a rendering of columns. `message` is what the commit message on `stages.yaml` used to be.
 * generated from [StageConfigDocument](file://./../../../../apps/api/data/contracts/stages.ck#L27)
 */
export interface StageConfigDocument {
    id: string;
    yaml: string;
    message: string;
    createdAt: string;
}

/**
 * `message` optional: `wilson stages edit` has no commit-message prompt the way `git commit` does,
 * and a default ("Edited stage config") beats forcing one. Supply it when the change is worth a
 * sentence — "Raise the review step budget to 150" is what the history is for.
 * generated from [SetStageConfigRequest](file://./../../../../apps/api/data/contracts/stages.ck#L37)
 */
export interface SetStageConfigRequest {
    yaml: string;
    message?: string;
}

/**
 * generated from [StageConfigVersion](file://./../../../../apps/api/data/contracts/stages.ck#L42)
 */
export interface StageConfigVersion {
    id: string;
    message: string;
    createdAt: string;
}

/**
 * Same shape as board.ck's `ListQuery`, declared here rather than shared: a contract file is the
 * unit contractkit generates from, and a cross-file reference is not worth a coupling for one
 * optional field.
 * generated from [StageConfigVersionsQuery](file://./../../../../apps/api/data/contracts/stages.ck#L51)
 */
export interface StageConfigVersionsQuery {
    limit?: number;
}
