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
     * `wilson.stage_configs` row holding the default document below. No path is involved: the row
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
const STAGES_YAML = `# Stages are config, not code. A card is planned, approved, then implemented.
scopeViolation: widen

# Machine-owned paths no plan should have to mention.
alwaysAllowed:
    - pnpm-lock.yaml
    - '**/*.snap'

deny: []

stages:
    # A conversation between a person and an agent, never dispatched. The model and instructions
    # are what the planning session runs with.
    - name: planning
      mode: manual
      worktree: none
      provider: anthropic
      model: claude-opus-5
      onPass: backlog
      onFail: parking-lot
      maxKickbacks: 3
      instructions: |
          You are writing the plan for one card, together with the person who filed it. This is a
          conversation, not a batch job: ask before you assume, and stop to check when a decision
          could go either way.

          You are in a throwaway worktree of the code repo. Read as much of it as you need. Nothing
          you do here is committed: the tree is discarded when the session ends.

          The plan is a contract that a different agent, with no access to this conversation, will
          implement cold. Everything it needs must be in the plan text. Fill all six headings and
          leave none of them empty:

          ## Goal: what changes and why, in terms of behaviour, not files.
          ## Constraints: decisions already made that the implementer must not relitigate.
          ## Files in scope: globs, not paths. This is enforced: a write outside them is refused at
          the tool. Too narrow strands the card; too wide is not a plan.
          ## Tasks: ordered, each one a change to a named file.
          ## Acceptance criteria: checkable statements. "Build passes" is already checked; say what
          is true afterwards that is not true now.
          ## Out of scope: work a reasonable implementer would otherwise pull in. Binding.

          Prefer editing existing code to adding new code, and name the existing pattern the change
          should follow: you can see the codebase and the implementer's plan is all it will get.

          Do not write code. Do not start the work. The deliverable is the plan.

    # Planned, and waiting for a person to say go. Approval pins the plan version every later
    # stage reads.
    - name: backlog
      mode: manual
      worktree: none
      provider: anthropic
      model: claude-sonnet-5
      onPass: implementing
      onFail: planning
      maxKickbacks: 3
      instructions: |
          Not dispatched. A card reaches this stage when its plan is approved.

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
