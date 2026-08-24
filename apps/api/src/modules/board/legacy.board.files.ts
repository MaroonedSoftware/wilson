import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { parseCard } from './card.parser.js';
import { BoardConfig } from './board.config.js';
import type { Card } from './card.js';

const CARDS_DIR = 'cards';

/**
 * Reads a pre-Postgres board repo: one markdown file per card under `cards/`.
 *
 * A reader and nothing else. The write half — serialize, commit, mutex — went with the cutover and
 * is not coming back: an import reads, and the board repo it reads from is archived afterwards. The
 * in-process mutex that used to serialize writes here is replaced by `SELECT ... FOR UPDATE`, which
 * holds against every writer rather than only this process.
 */
@Injectable()
export class LegacyBoardFiles {
    constructor(
        private readonly config: BoardConfig,
        private readonly logger: Logger,
    ) {}

    async list(): Promise<Card[]> {
        const dir = join(this.config.boardRoot, CARDS_DIR);
        const entries = await readdir(dir).catch(() => [] as string[]);
        const cards: Card[] = [];
        for (const entry of entries.filter(e => e.endsWith('.md')).sort()) {
            try {
                cards.push(parseCard(await readFile(join(dir, entry), 'utf8')));
            } catch (err) {
                // One malformed card must not hide the rest: an import that silently dropped a card
                // would look like it succeeded. Surfaced here, and the count in the report is what
                // the operator checks it against.
                this.logger.warn(`skipping unparseable card ${entry}: ${(err as Error).message}`);
            }
        }
        return cards;
    }
}
