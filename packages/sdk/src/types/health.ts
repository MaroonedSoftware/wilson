/**
 * What the server says about itself. `head` is the commit captured at boot, not the repo's current
 * HEAD: this project lost three runs to a daemon quietly serving code from before a fix, and a field
 * read per request would report the new commit and make exactly that daemon look current.
 * generated from [Health](file://./../../../../apps/api/data/contracts/health.ck#L11)
 */
export interface Health {
    ok: boolean;
    project: string;
    head: string;
}
