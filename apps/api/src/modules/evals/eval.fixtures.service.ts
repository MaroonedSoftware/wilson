import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { git } from '#modules/board/git.js';
import type { CaptureEvalFixtureRequest, EvalFixture, SetEvalFixtureExpectedRequest } from '../../generated/evals.js';
import { expectedFromAttempt, resolveAttempt } from './eval.attempt.js';
import { EvalFixtureRepository, type EvalFixtureRow } from './eval.fixture.repository.js';

/**
 * The stages an eval can replay. A step is left out on purpose: `challenge` takes a review's findings
 * as its input, which a plan and a tree cannot give it.
 */
export const EVAL_STAGES: readonly string[] = ['implementing', 'testing', 'review'];

const IS_ID = /^[1-9]\d{0,17}$/;

const pinRef = (id: string, which: 'base' | 'head'): string => `refs/wilson/eval/${id}/${which}`;

const toContract = (fixture: EvalFixtureRow, warnings: string[] = []): EvalFixture => ({
    id: fixture.id,
    sourceCardId: fixture.sourceCardId,
    title: fixture.plan.frontmatter.title,
    stage: fixture.stage,
    planVersionId: fixture.planVersionId,
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    ...(fixture.expected && { expected: fixture.expected }),
    warnings,
    createdAt: fixture.createdAt,
});

/** Turns a past stage attempt into something an eval can run again. Reads the card and never writes it. */
@Injectable()
export class EvalFixturesService {
    constructor(
        private readonly config: BoardConfig,
        private readonly board: BoardRepository,
        private readonly fixtures: EvalFixtureRepository,
    ) {}

    async capture({ cardId, stage, attempt }: CaptureEvalFixtureRequest): Promise<EvalFixture> {
        if (!EVAL_STAGES.includes(stage)) {
            throw httpError(400).withDetails({ reason: `an eval can replay ${EVAL_STAGES.join(', ')}, not "${stage}"` });
        }

        const events = await this.fixtures.attemptEvents(cardId);
        const resolved = resolveAttempt(events, stage, attempt);
        if (!resolved) {
            const which = attempt === undefined ? 'an attempt' : `attempt ${attempt}`;
            throw httpError(404).withDetails({ reason: `card ${cardId} has no record of ${which} at ${stage}` });
        }

        const dispatch = events.find(event => event.id === resolved.eventId)!;
        const planVersionId = resolved.planVersionId ?? (await this.fixtures.pinnedVersionAt(cardId, dispatch.createdAt));
        if (!planVersionId) {
            throw httpError(404).withDetails({ reason: `card ${cardId} has no plan version from before that attempt` });
        }
        const plan = await this.board.readAt(cardId, planVersionId);

        await this.assertUsable(resolved.baseSha, resolved.headSha);

        const expected = stage === 'review' ? expectedFromAttempt(events, resolved.eventId) : undefined;
        const fixture = await this.fixtures.insert({
            sourceCardId: cardId,
            stage,
            sourceEventId: resolved.eventId,
            planVersionId,
            plan,
            baseSha: resolved.baseSha,
            headSha: resolved.headSha,
            ...(expected && { expected }),
        });
        if (!fixture) {
            throw httpError(409).withDetails({ reason: `that attempt of card ${cardId} at ${stage} is already a fixture` });
        }

        try {
            await git(this.config.codeRoot, ['update-ref', pinRef(fixture.id, 'base'), fixture.baseSha]);
            await git(this.config.codeRoot, ['update-ref', pinRef(fixture.id, 'head'), fixture.headSha]);
        } catch (err) {
            await this.fixtures.remove(fixture.id);
            await this.unpin(fixture.id);
            throw err;
        }

        const warnings = plan.frontmatter.splitFrom
            ? [`card ${cardId} was split from ${plan.frontmatter.splitFrom}; a plan citing its parent's patch will not find it in a replay`]
            : [];
        return toContract(fixture, warnings);
    }

    async list(): Promise<EvalFixture[]> {
        return (await this.fixtures.list()).map(fixture => toContract(fixture));
    }

    /** A person's word on what a review of this fixture should find, replacing what the card's review said. */
    async setExpected(id: string, { verdict, blockerFiles }: SetEvalFixtureExpectedRequest): Promise<EvalFixture> {
        const fixture = IS_ID.test(id) ? await this.fixtures.find(id) : undefined;
        if (!fixture) throw httpError(404).withDetails({ reason: `no fixture ${id}` });
        if (fixture.stage !== 'review') {
            throw httpError(400).withDetails({ reason: `fixture ${id} is an attempt at ${fixture.stage}; only a review has an expected verdict` });
        }
        if (verdict === 'pass' && blockerFiles && blockerFiles.length > 0) {
            throw httpError(400).withDetails({ reason: 'an expected pass has no blockers to name' });
        }
        const expected = { verdict, blockerFiles: blockerFiles ?? [], source: 'operator' as const };
        await this.fixtures.setExpected(id, expected);
        return toContract({ ...fixture, expected });
    }

    async remove(id: string): Promise<void> {
        if (!IS_ID.test(id) || !(await this.fixtures.find(id))) {
            throw httpError(404).withDetails({ reason: `no fixture ${id}` });
        }
        await this.fixtures.remove(id);
        await this.unpin(id);
    }

    /** A commit gone from the clone cannot be replayed, and a head not built on its base has no diff to judge. */
    private async assertUsable(baseSha: string, headSha: string): Promise<void> {
        for (const sha of [baseSha, headSha]) {
            await git(this.config.codeRoot, ['cat-file', '-e', `${sha}^{commit}`]).catch(() => {
                throw httpError(409).withDetails({ reason: `commit ${sha.slice(0, 8)} is no longer in this project's clone` });
            });
        }
        await git(this.config.codeRoot, ['merge-base', '--is-ancestor', baseSha, headSha]).catch(() => {
            throw httpError(409).withDetails({ reason: `commit ${headSha.slice(0, 8)} is not built on ${baseSha.slice(0, 8)}` });
        });
    }

    private async unpin(id: string): Promise<void> {
        for (const which of ['base', 'head'] as const) {
            await git(this.config.codeRoot, ['update-ref', '-d', pinRef(id, which)]).catch(() => undefined);
        }
    }
}
