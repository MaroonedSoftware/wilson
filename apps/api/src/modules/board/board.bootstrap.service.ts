import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { NON_STAGE_STATES } from '#modules/stages/stage.config.js';
import { StageConfigStore } from '#modules/stages/stage.config.store.js';
import type { BoardColumns } from '../../generated/board.js';
import { BoardConfig } from './board.config.js';

/**
 * Board bootstrap: initialising the board itself, not a card.
 *
 * `wilson board init` used to scaffold the sibling board repo from the CLI process, and later
 * (card 0076) behind this service; `wilson board import` carried a markdown board into Postgres the
 * same way, once, on 2026-08-24. The board is Postgres now, stage config included, so the importer
 * is gone and all that is left to initialise is the project's first stage config.
 */
@Injectable()
export class BoardBootstrapService {
    constructor(
        private readonly boardConfig: BoardConfig,
        private readonly stageConfigs: StageConfigStore,
    ) {}

    /**
     * Give the project a stage config an operator can start a card against immediately — the
     * `runner.stage_configs` row holding the default document below. No path is involved: the row
     * is keyed by the project the request is for.
     *
     * Refuses rather than resets: a project that already has a stage config exists, and init
     * scaffolds a board, it does not reset one — `wilson stages edit` is how a config changes.
     *
     * The scaffolded config is read back through `StageConfigStore.load` before this reports success
     * (`save` validates it, and `load` is what every dispatch reads) — card 0060 fixed a scaffolded
     * config that `loadStages` rejected (it routed to stages that did not exist and nothing caught
     * it), and this is what keeps that class of bug from coming back.
     */
    async init(): Promise<BoardColumns> {
        if (await this.stageConfigs.read()) {
            throw httpError(409).withDetails({ reason: `project "${this.boardConfig.project}" already has a stage config` });
        }

        await this.stageConfigs.save(STAGES_YAML, 'Initialise board');

        const stages = await this.stageConfigs.load();
        return { stages: stages.stages.map(stage => stage.name), nonStages: [...NON_STAGE_STATES] };
    }
}

// Moved from `packages/cli/src/commands/board/init.command.ts` unchanged apart from where it lives —
// card 0060 fixed this template's routing and that fix must survive the move intact. The first
// stage config a project gets; `wilson stages edit` takes it from here.
const STAGES_YAML = `# Stages are config, not code. Step 0 configures exactly one.
scopeViolation: widen

# Machine-owned paths no plan should have to mention.
alwaysAllowed:
    - pnpm-lock.yaml
    - '**/*.snap'

deny: []

stages:
    - name: implementing
      mode: agent
      worktree: rw
      provider: anthropic
      model: claude-sonnet-5
      maxSteps: 60
      maxOutputTokens: 16000
      allowedCommands:
          - pnpm build
          - pnpm test
          - pnpm lint
          - pnpm install
      buildCommand: pnpm build
      onPass: merged
      onFail: implementing
      maxKickbacks: 3
      instructions: |
          You are implementing one card in an isolated git worktree.

          The plan file is the contract. Read it first and do what it says — no more. Work outside
          its "Files in scope" is not scope you are missing, it is scope the plan deliberately drew:
          if you genuinely need a file it does not cover, call request_scope and explain why.

          Prefer editing existing code over adding new code, and match the conventions of the file
          you are in. Run the build before you finish. Return the structured result when done.
`;
