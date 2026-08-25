import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Card 0062's actual fix does not live in this repo: stage routing is config
 * (`config/stages.yaml` on the board, not the code repo), and the write tool denies every stage
 * from touching it — so the concrete edit (`testing.onFail: testing`) has to be handed to the
 * operator rather than committed here. What this card *can* do, and what the plan asks for under
 * "Decide where a testing failure belongs", is write the reasoning down where the next person will
 * find it: in the schema's own `onFail` field, next to `kickback`'s routing logic, and in
 * `PROJECT.md`'s stage table.
 *
 * These are the only places that reasoning can be observed, so this test reads the source directly
 * rather than exercising a code path — there is no runtime behavior change to assert on here that
 * `kickback.testing-onfail.test.ts` doesn't already cover. Against the pre-change tree, none of
 * this text exists yet.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string): string => readFileSync(join(here, relativePath), 'utf8');

describe('card 0062 — the kickback-target reasoning is written down', () => {
    it('documents on StageConfig.onFail that the target is the stage that can fix the failure, not the previous one', () => {
        const stageConfigSource = read('../../../src/modules/stages/stage.config.ts');

        expect(stageConfigSource).toContain('the stage that can fix the failure');
        expect(stageConfigSource).toContain('not automatically the stage before this');
    });

    it('documents on StageConfig.onFail why review.onFail: implementing stays correct while testing.onFail must not mirror it', () => {
        const stageConfigSource = read('../../../src/modules/stages/stage.config.ts');

        expect(stageConfigSource).toContain('`review.onFail: implementing` is correct');
        expect(stageConfigSource).toContain('Card 0060 hit this the expensive way');
        expect(stageConfigSource).toContain('A self-targeting `onFail` (`testing.onFail: testing`) is not a special case here');
    });

    it('documents on kickback() that a self-targeting onFail is handled the same as any other target', () => {
        const kickbackSource = read('../../../src/modules/stages/kickback.ts');

        expect(kickbackSource).toContain('chosen for who can fix it');
        expect(kickbackSource).toContain('a self-loop retries and eventually flags a human exactly like a kickback to any other stage');
    });

    it('states the kickback-target rule in PROJECT.md, next to the stage table it qualifies', () => {
        const projectMd = read('../../../../../PROJECT.md');

        expect(projectMd).toContain('a kickback target');
        expect(projectMd).toContain('is the stage that can fix the failure');
        expect(projectMd).toContain('`testing.onFail: testing` is also');
        expect(projectMd).toContain('correct, and looks wrong at first glance');
    });
});
