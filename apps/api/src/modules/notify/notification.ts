/**
 * Which of the three moments PROJECT.md's Notification section names produced this notification.
 *
 * A `manual` gate reached normally, a card flagged for a human (retries exhausted or over budget),
 * and a poisoning call for three different responses from the reader — that is why the payload
 * names which one this is rather than leaving the reader to infer it from the stage alone.
 */
export type NotifyMoment = 'manual' | 'needs-human' | 'poisoned';

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
