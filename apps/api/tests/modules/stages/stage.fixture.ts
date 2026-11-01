import type { Card, CardFrontmatter } from '#modules/board/card.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

/**
 * What `StageConfigSchema` resolves for the fields a hand-written stage fixture leaves out. Spread
 * first, so anything a fixture sets itself still wins, and every fixture stays a complete
 * `StageConfig` without repeating budgets that have nothing to do with what it tests.
 */
export const stageDefaults: Pick<
    StageConfig,
    'adapter' | 'placement' | 'sandboxAllowedDomains' | 'maxInputTokens' | 'maxContextWindowFraction' | 'maxWallClockMs' | 'maxIdleMs'
> = {
    adapter: 'api',
    placement: 'local',
    sandboxAllowedDomains: [],
    maxInputTokens: 15_000_000,
    maxContextWindowFraction: 0.9,
    maxWallClockMs: 1_800_000,
    maxIdleMs: 300_000,
};

/** A plan-less card, for a verifier whose checks under test never read `VerificationInput.card`. */
export const planlessCard = (): Card => ({
    frontmatter: { id: '0001', title: 'Card 0001', stage: 'testing', dependsOn: [], retries: {} } as CardFrontmatter,
    sections: {},
    body: '',
});
