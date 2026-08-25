import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '@wilson/api/cli-bootstrap';

/**
 * Open `$EDITOR` on some text and return what came back, or undefined if it came back empty.
 *
 * Empty means abandon, the convention `git commit` uses: an editor session the operator closed
 * without writing anything should not be read as "delete the plan".
 */
export const editBody = async (initial: string, name: string): Promise<string | undefined> => {
    const dir = await mkdtemp(join(tmpdir(), 'wilson-edit-'));
    const path = join(dir, `${name}.md`);
    await writeFile(path, initial, 'utf8');

    const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
    await new Promise<void>((resolve, reject) => {
        const child = spawn(editor, [path], { stdio: 'inherit', shell: true });
        child.on('error', reject);
        child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${editor} exited with ${code}`))));
    });

    const body = await readFile(path, 'utf8');
    return body.trim().length === 0 ? undefined : body;
};

/**
 * Spawn a foreground process, handing it the terminal, and wait for it to exit.
 *
 * The same shape as the `$EDITOR` spawn above, generalized: `plan.command.ts` uses it to hand the
 * terminal to `claude` for an interactive planning session, exactly as `editBody` hands it to
 * `$EDITOR`. No `shell: true` here — `plan.command.ts` calls this with a fixed binary name and an
 * argv array of flags, none of which need shell parsing the way an `$EDITOR` value like `code --wait`
 * does. Resolves on any exit, including non-zero: what matters afterward is what the process wrote to
 * disk, not the code it left with.
 */
export const runInteractive = async (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', ...options });
        child.on('error', reject);
        child.on('exit', () => resolve());
    });
};

/**
 * The next id on the board.
 *
 * Sequential and zero-padded, because ids are typed into commands, read in `dependsOn` and carried
 * in branch names. Collision-free allocation is the database's job — `runner.cards` has a primary
 * key on `(project, id)`, so two creators racing produce an error rather than one silently
 * overwriting the other, which is exactly what the file-backed board did.
 */
export const nextCardId = (cards: Card[]): string => {
    const highest = cards.reduce((max, card) => Math.max(max, Number.parseInt(card.frontmatter.id, 10) || 0), 0);
    return String(highest + 1).padStart(4, '0');
};
