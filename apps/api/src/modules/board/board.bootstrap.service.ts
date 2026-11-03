import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { NON_STAGE_STATES } from '#modules/stages/stage.config.js';
import type { LaneConfig } from '#modules/stages/lane.rows.js';
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
     * Give the project lanes an operator can start a card against immediately. No path is involved:
     * the rows are keyed by the project the request is for.
     *
     * Refuses rather than resets: a project that already has lanes exists, and init scaffolds a
     * board, it does not reset one. `wilson stages set` is how a lane changes.
     *
     * The scaffolded lanes are read back through `StageConfigStore.load` before this reports success,
     * since `load` is what every dispatch reads. Card 0060 fixed a scaffolded config that was rejected
     * there (it routed to stages that did not exist and nothing caught it), and this keeps that class
     * of bug from coming back.
     */
    async init(): Promise<BoardColumns> {
        if ((await this.stageConfigs.lanes()).length > 0) {
            throw httpError(409).withDetails({ reason: `project "${this.boardConfig.project}" already has a stage config` });
        }

        await this.stageConfigs.seedLanes(DEFAULT_LANES, 'Initialise board');

        const stages = await this.stageConfigs.load();
        return { stages: stages.stages.map(stage => stage.name), nonStages: [...NON_STAGE_STATES] };
    }
}

// What `wilson board init` gives a new project. `wilson stages set` and `route` take it from here.
const DEFAULT_LANES: LaneConfig = {
    project: {
        scopeViolation: 'widen',
        // Machine-owned paths no plan should have to mention.
        alwaysAllowed: ['pnpm-lock.yaml', '**/*.snap'],
        deny: [],
        sandbox: { enabled: false, allowedDomains: [] },
    },
    lanes: [
        // A conversation between a person and an agent, never dispatched. The model and instructions
        // are what the planning session runs with.
        {
            name: 'planning',
            position: 0,
            mode: 'manual',
            worktree: 'none',
            provider: 'anthropic',
            model: 'claude-opus-5',
            onPass: 'backlog',
            onFail: 'parking-lot',
            settings: { maxKickbacks: 3 },
            instructions: `You are writing the plan for one card, together with the person who filed it. This is a
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
`,
        },
        // Planned, and waiting for a person to say go. Approval pins the plan version every later
        // stage reads.
        {
            name: 'backlog',
            position: 1,
            mode: 'manual',
            worktree: 'none',
            onPass: 'implementing',
            onFail: 'planning',
            settings: { maxKickbacks: 3 },
            instructions: `Not dispatched. A card reaches this stage when its plan is approved.
`,
        },
        {
            name: 'implementing',
            position: 2,
            mode: 'agent',
            worktree: 'rw',
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            onPass: 'done',
            onFail: 'implementing',
            settings: {
                maxSteps: 60,
                maxOutputTokens: 16000,
                allowedCommands: ['pnpm build', 'pnpm test', 'pnpm lint', 'pnpm install'],
                buildCommand: 'pnpm build',
                maxKickbacks: 3,
            },
            instructions: `You are implementing one card in an isolated git worktree.

The plan file is the contract. Read it first and do what it says — no more. Work outside
its "Files in scope" is not scope you are missing, it is scope the plan deliberately drew:
if you genuinely need a file it does not cover, call request_scope and explain why.

Prefer editing existing code over adding new code, and match the conventions of the file
you are in. Run the build before you finish. Return the structured result when done.
`,
        },
    ],
};
