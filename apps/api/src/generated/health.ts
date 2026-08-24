import { z } from 'zod';

/**
 * What the server says about itself. `head` is the commit captured at boot, not the repo's current
 * HEAD: this project lost three runs to a daemon quietly serving code from before a fix, and a field
 * read per request would report the new commit and make exactly that daemon look current.
 * generated from [Health](file://./../../data/contracts/health.ck#L11)
 */
export const Health = z.strictObject({
    ok: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    project: z.string(),
    head: z.string(),
});
export type Health = z.infer<typeof Health>;
