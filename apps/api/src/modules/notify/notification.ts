/**
 * Which of the moments PROJECT.md's Notification section (and card 0200's Note) names produced
 * this notification.
 *
 * A `manual` gate reached normally, a card flagged for a human (retries exhausted or over budget),
 * a poisoning call, and a card source's ticket closing externally — four different responses from
 * the reader, which is why the payload names which one this is rather than leaving the reader to
 * infer it from the stage alone.
 *
 * `source-closed` is its own moment, not a reuse of `needs-human`: card 0200's `InboundCardWriter`
 * sends it for a card dropped or flagged-at-`ready` because its ticket closed externally — an FYI
 * and a "please decide," neither of which is `needs-human`'s existing meaning (retries exhausted or
 * over budget) or `manual`'s (a gate reached normally). The one exception is the mid-run halt
 * (`StageDispatcher.writeTransition`), which keeps using `needs-human` with `reason: 'source-closed'`
 * since that machinery already notifies on every fresh flag.
 *
 * `auto-split` says a refusal retired a card in favour of pieces that now wait in `planning`: nothing
 * failed and nothing is flagged, but nothing moves until a person plans them.
 */
export type NotifyMoment = 'manual' | 'needs-human' | 'poisoned' | 'source-closed' | 'auto-split';

/**
 * Everything a notification says, independent of the channel that carries it.
 *
 * Deliberately self-contained (card 0050's Tasks, item 4: "whoever receives it should not need
 * this codebase to read it") — the card id, its title, where it is, which moment this is, why when
 * there is a why, and a deep link are all a reader needs to act without opening the board.
 */
export interface CardNotification {
    readonly project: string;
    readonly cardId: string;
    readonly title: string;
    readonly stage: string;
    readonly moment: NotifyMoment;
    /** Why, when the moment carries one: a kickback-exhaustion or over-budget message, a poison reason. */
    readonly reason?: string;
}
