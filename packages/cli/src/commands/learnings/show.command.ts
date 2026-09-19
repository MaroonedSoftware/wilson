import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Print the project's learnings document (`GET /api/learnings`) — the human-approved surface card
 * 0239 adds, mirroring `wilson stages show`.
 *
 * Written to stdout verbatim rather than through the logger, so `wilson learnings show > learnings.md`
 * round-trips: the file it produces is exactly what `wilson learnings set` accepts. A project with no
 * saved document yet prints nothing (the API answers with an empty document, not a 404).
 */
const command: CommandModule = {
    description: "Print the project's learnings document",
    run: withApi(async (_opts, _ctx, _args, api) => {
        const document = await api.learnings.getLearnings();
        if (document.markdown.length === 0) return 0;
        process.stdout.write(document.markdown.endsWith('\n') ? document.markdown : `${document.markdown}\n`);
        return 0;
    }),
};

export default command;
