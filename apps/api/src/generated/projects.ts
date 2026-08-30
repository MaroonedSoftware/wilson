import { z } from 'zod';

/**
 * One registered project's identity, as far as an HTTP caller needs to know it. `ProjectRow`
 * (project.repository.ts) also carries `boardRoot`, `codeRoot`, `worktreeRoot` and `runRoot` —
 * filesystem layout of the machine the daemon runs on — which are withheld here: a switcher needs
 * names, and an unauthenticated surface (see `security: none` above) is a reason to return the
 * minimum that serves the consumer, not a licence to expose everything `ProjectRepository.list()`
 * already reads.
 * generated from [Project](file://./../../data/contracts/projects.ck#L29)
 */
export const Project = z.strictObject({
    name: z.string(),
});
export type Project = z.infer<typeof Project>;
