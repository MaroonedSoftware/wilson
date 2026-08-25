import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { loadStages, NON_STAGE_STATES } from '#modules/stages/stage.config.js';
import type { BoardColumns, ImportBoardRequest, ImportReport } from '../../generated/board.js';
import { BoardConfig } from './board.config.js';
import { BoardImporter } from './board.importer.js';

const exec = promisify(execFile);

/**
 * Board bootstrap: scaffolding and importing the board itself, not a card.
 *
 * The API already knows where the board is (`BoardConfig.boardRoot`); neither operation here takes
 * a path from the caller. That circularity is real and acceptable — the API must be running, with
 * `PROJECT_BOARD_ROOT` already pointing at the intended path, before it can scaffold a board there —
 * but the root is configuration, not something `init` discovers, and a request that could name an
 * arbitrary filesystem path would be a remote write primitive, which this is not.
 *
 * Previously `wilson board init` and `wilson board import` ran against the filesystem and the
 * database directly from the CLI process. With every card mutation on the API (card 0075), this
 * closes the last board writes that were not.
 */
@Injectable()
export class BoardBootstrapService {
    constructor(
        private readonly boardConfig: BoardConfig,
        private readonly importer: BoardImporter,
    ) {}

    /**
     * Scaffold `boardRoot`: `cards/`, `config/`, `context/`, a `stages.yaml` an operator can start a
     * card against immediately, and a git repo to commit it into.
     *
     * Refuses rather than resets: a `stages.yaml` already at `boardRoot` means this board exists,
     * and init scaffolds a board, it does not reset one.
     *
     * The scaffolded config is read back through `loadStages` before this reports success — card
     * 0060 fixed a scaffolded config that `loadStages` rejected (it routed to stages that did not
     * exist and nothing caught it), and this is what keeps that class of bug from coming back.
     */
    async init(): Promise<BoardColumns> {
        const root = this.boardConfig.boardRoot;
        if (existsSync(join(root, 'config', 'stages.yaml'))) {
            throw httpError(409).withDetails({ reason: `board already initialised at ${root}` });
        }

        for (const dir of ['cards', 'config', 'context']) {
            await mkdir(join(root, dir), { recursive: true });
        }

        await writeFile(join(root, 'config', 'stages.yaml'), STAGES_YAML, 'utf8');
        await writeFile(join(root, '.gitignore'), 'context/**/raw/\n', 'utf8');
        await writeFile(join(root, 'README.md'), README, 'utf8');

        if (!existsSync(join(root, '.git'))) {
            await exec('git', ['init', '-q'], { cwd: root });
        }
        await exec('git', ['add', '-A'], { cwd: root });
        await exec('git', ['commit', '-q', '-m', 'Initialise board'], { cwd: root }).catch(() => undefined);

        const stages = await loadStages(root);
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
// card 0060 fixed this template's routing and that fix must survive the move intact. The CLI command
// still carries its own copy for now (card 0074 points it at this endpoint instead).
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

const README = `# board

The board for this project: one markdown file per card under \`cards/\`, stage config under
\`config/\`, and planning context snapshots under \`context/\`.

This is a separate git repo from the code on purpose. Card worktrees are cut from the code repo,
which contains none of these files, so a card branch cannot carry stale board state or resurrect it
in a merge.
`;
