import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { NON_STAGE_STATES } from '#modules/stages/stage.config.js';
import { StageConfigStore } from '#modules/stages/stage.config.store.js';
import type { BoardColumns, ImportBoardRequest, ImportReport } from '../../generated/board.js';
import { BoardConfig } from './board.config.js';
import { BoardImporter } from './board.importer.js';

/**
 * Board bootstrap: scaffolding and importing the board itself, not a card.
 *
 * Previously `wilson board init` and `wilson board import` ran against the filesystem and the
 * database directly from the CLI process. With every card mutation on the API (card 0075), this
 * closes the last board writes that were not.
 */
@Injectable()
export class BoardBootstrapService {
    constructor(
        private readonly boardConfig: BoardConfig,
        private readonly stageConfigs: StageConfigStore,
        private readonly importer: BoardImporter,
    ) {}

    /**
     * Give the project a stage config an operator can start a card against immediately.
     *
     * This used to scaffold the sibling board repo — `cards/`, `config/stages.yaml`, `context/`, a
     * git repo to commit it into. The board is Postgres now, stage config included, so all that is
     * left to initialise is the config row, and there is no path involved: the row is keyed by the
     * project the request is for.
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

    /**
     * Import the legacy markdown board (`cards/*.md`) into Postgres. Mirrors `wilson board import`:
     * a dry run reports what would happen without writing, and `BoardImporter` still refuses a board
     * that already has cards — that guard does not become optional over HTTP.
     */
    async import(request: ImportBoardRequest): Promise<ImportReport> {
        const cards = await this.importer.readLegacyBoard();
        if (cards.length === 0) {
            throw httpError(400).withDetails({ reason: `no cards found under ${this.boardConfig.boardRoot}/cards` });
        }

        try {
            return await this.importer.import(cards, { dryRun: request.dryRun ?? false });
        } catch (err) {
            throw httpError(400).withDetails({ reason: (err as Error).message });
        }
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
