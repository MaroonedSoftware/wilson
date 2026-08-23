import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardConfig } from '@wilson/api/cli-bootstrap';

const exec = promisify(execFile);

/**
 * Scaffold the board repo.
 *
 * The board is its own git repo beside the code repo, not a directory inside it (PROJECT.md, Board
 * format). That is what makes "a card branch never touches board state" structural: a card worktree
 * is cut from the code repo, which contains none of this.
 */
const command: CommandModule = {
    description: 'Create the sibling board repo with its cards, config and context directories',
    run: requireContainer(async (_opts, ctx) => {
        const config = ctx.container.get(BoardConfig);
        const root = config.boardRoot;

        if (existsSync(join(root, 'config', 'stages.yaml'))) {
            ctx.logger.info(`board already initialised at ${root}`);
            return 0;
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

        ctx.logger.info(`board initialised at ${root}`);
        ctx.logger.info('Write a card by hand in cards/, then: wilson card run <id>');
        return 0;
    }),
};

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
      onPass: testing
      onFail: planning
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

export default command;
