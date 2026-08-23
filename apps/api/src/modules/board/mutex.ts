/**
 * A promise mutex.
 *
 * Board writes must be serial: a transition is read-modify-write over a card file plus a commit, and
 * two of those interleaving in one repo produces either a lost update or a commit of somebody
 * else's half-written state.
 *
 * Today the runner is one process running one card, so this is trivially uncontended. It is written
 * as a real lock anyway because step 3 introduces concurrent dispatch, and the failure it prevents
 * is silent.
 */
export class Mutex {
    private tail: Promise<unknown> = Promise.resolve();

    async run<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.tail.then(fn, fn);
        // Swallow rejections on the chain itself so one failed write does not poison the queue;
        // the caller still sees the rejection through `result`.
        this.tail = result.catch(() => undefined);
        return result;
    }
}
