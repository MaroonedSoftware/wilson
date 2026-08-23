import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { parseCard, serializeCard } from './card.parser.js';
import { git, lastCommitSha } from './git.js';
import { Mutex } from './mutex.js';
import type { Card } from './card.js';
import { BoardConfig } from './board.config.js';

const CARDS_DIR = 'cards';

/**
 * The board repo.
 *
 * Knows nothing about the CLI. It is a library the CLI drives today and the API drives from step 6,
 * which is the seam that keeps step 6 from being a rewrite.
 *
 * Every mutation goes through `write`, which holds the mutex, writes one file, and commits. The
 * runner is the sole writer of card state (PROJECT.md decision 5); a human editing a card file
 * directly is reconciled, not prevented, but that path is not this class.
 */
@Injectable()
export class BoardRepository {
    private readonly mutex = new Mutex();

    constructor(
        private readonly config: BoardConfig,
        private readonly logger: Logger,
    ) {}

    private cardPath(id: string): string {
        return join(CARDS_DIR, `${id}.md`);
    }

    async list(): Promise<Card[]> {
        const dir = join(this.config.boardRoot, CARDS_DIR);
        const entries = await readdir(dir).catch(() => [] as string[]);
        const cards: Card[] = [];
        for (const entry of entries.filter(e => e.endsWith('.md')).sort()) {
            try {
                cards.push(parseCard(await readFile(join(dir, entry), 'utf8')));
            } catch (err) {
                // One malformed card must not blind the operator to every other card; surface it and
                // keep going. `card show` on that id will still throw with the parse error.
                this.logger.warn(`skipping unparseable card ${entry}: ${(err as Error).message}`);
            }
        }
        return cards;
    }

    async read(id: string): Promise<Card> {
        return parseCard(await readFile(join(this.config.boardRoot, this.cardPath(id)), 'utf8'));
    }

    /**
     * Read a card as it stood at a specific commit.
     *
     * This is how a running stage sees its plan: pinned to `planSha`, so an edit landing on the
     * board while the stage runs cannot change the contract underneath it.
     */
    async readAt(id: string, sha: string): Promise<Card> {
        const { stdout } = await git(this.config.boardRoot, ['show', `${sha}:${this.cardPath(id)}`]);
        return parseCard(stdout);
    }

    /** The commit that last touched this card's file. */
    async currentSha(id: string): Promise<string | undefined> {
        return lastCommitSha(this.config.boardRoot, this.cardPath(id));
    }

    /**
     * Apply a change to one card and commit it.
     *
     * Read-modify-write under the mutex: the mutate callback receives the card as it is on disk
     * right now, not a copy the caller read earlier and may have been holding while something else
     * wrote. Returns the new commit sha.
     */
    async write(id: string, message: string, mutate: (card: Card) => Card | Promise<Card>): Promise<string> {
        return this.mutex.run(async () => {
            const relative = this.cardPath(id);
            const absolute = join(this.config.boardRoot, relative);
            const updated = await mutate(parseCard(await readFile(absolute, 'utf8')));
            await writeFile(absolute, serializeCard(updated), 'utf8');
            await git(this.config.boardRoot, ['add', '--', relative]);
            await git(this.config.boardRoot, ['commit', '-m', message, '--', relative]);
            return (await lastCommitSha(this.config.boardRoot, relative)) ?? '';
        });
    }

    /** Create a card file that does not exist yet, and commit it. */
    async create(card: Card, message: string): Promise<string> {
        return this.mutex.run(async () => {
            const relative = this.cardPath(card.frontmatter.id);
            await writeFile(join(this.config.boardRoot, relative), serializeCard(card), 'utf8');
            await git(this.config.boardRoot, ['add', '--', relative]);
            await git(this.config.boardRoot, ['commit', '-m', message, '--', relative]);
            return (await lastCommitSha(this.config.boardRoot, relative)) ?? '';
        });
    }
}
