import { isOverBudgetMessage } from '#modules/agent/budget.js';
import { PROCESS_FAILURE_CLASSES, type FailureClass } from '#modules/stages/stage.result.js';
import type { DateTime } from 'luxon';
import type { ProjectGateDifficulty, ProjectGateKickback, ProjectGateTouchpoint } from '../../generated/board.js';

type TouchpointCause = ProjectGateTouchpoint['cause'];

/** The step a `revise` waits on, which `payload.step` names on its own events. */
const CHALLENGE_STEP = 'challenge';

/** A `to` that means a card finished its run. `ready` is the human gate, and a card can skip it to merge. */
const REACHED_THE_END = new Set(['ready', 'merged']);

/** What {@link foldGateStats} reads off one event, oldest first. Only these, since a run's `payload` is large. */
export interface GateEventRow {
    cardId: string;
    stage: string | null;
    type: string;
    step: string | null;
    verdict: string | null;
    failureClass: string | null;
    error: string | null;
    firstFailure: string | null;
    loopStopped: boolean | null;
    alreadyResolved: boolean | null;
    from: string | null;
    to: string | null;
    by: string | null;
    needsHuman: boolean | null;
    reason: string | null;
    /** A transition's whole counters, or the one count `card.acked` dropped. */
    retries: Record<string, number> | number | null;
    /** A stage's own note on what slowed it, lifted onto its event by the dispatcher. */
    difficulty?: string | null;
    createdAt?: DateTime;
}

/** How many difficulty notes the gate stats list. */
export const MAX_DIFFICULTIES = 20;

/** The figures {@link foldGateStats} works out from events, which `EventLog.gateStats` completes. */
export interface GateFigures {
    kickbacks: ProjectGateKickback[];
    failures: { failureClass: FailureClass; count: number; matched: number }[];
    revised: { stage: string; count: number }[];
    challenge: { upheld: number; overturned: number };
    questions: { asked: number; answered: number };
    loopStops: number;
    touchpoints: ProjectGateTouchpoint[];
    firstPass: { reached: number; firstPass: number };
    matched: number;
    difficulties: ProjectGateDifficulty[];
}

/**
 * Why an older `stage.failed` failed, from its leading failure, for events written before `failureClass`
 * was. Only messages the runner itself writes can be told apart this way (`agent/budget.ts` and the
 * dispatcher's own). Anything else is a verifier's, or a report it rejected, which older text cannot
 * separate, so those count as `verifier` and are labelled as matched.
 */
export const matchOlderFailure = (text: string | null): FailureClass => {
    if (!text) return 'verifier';
    if (/^the engine /.test(text)) return 'engine';
    if (isOverBudgetMessage(text)) return 'budget';
    if (/^the stage used all \d+ of its steps/.test(text)) return 'budget';
    if (/and the result did not arrive/.test(text)) return 'resultDropped';
    if (/^the stage ended without calling /.test(text)) return 'noReport';
    return 'verifier';
};

/** The event that says why the flag following it was raised. */
const CAUSE_OF: Partial<Record<string, TouchpointCause>> = {
    'stage.blocked': 'question',
    'card.over-budget': 'overBudget',
    'context.overflow': 'contextOverflow',
    'rebase.conflict': 'rebaseConflict',
    'stage.dead': 'dead',
    'stage.poisoned': 'poisoned',
};

/** What raised a runner's flag that no event before it named. */
const flagCause = (row: GateEventRow): TouchpointCause => {
    if (row.failureClass && PROCESS_FAILURE_CLASSES.has(row.failureClass)) return 'processFailure';
    return row.reason === 'source-closed' ? 'sourceClosed' : 'kickbackLimit';
};

const bump = <K>(counts: Map<K, number>, key: K, by = 1): void => {
    counts.set(key, (counts.get(key) ?? 0) + by);
};

/**
 * A retry the card paid for: a key that is a stage's own name. A key with a `:` in it is a free counter
 * kept beside the stage's (`x:resultDropped`, `x:blocked`, `review:re-review`), which says nothing about
 * whether the work passed. Stage names cannot hold a colon, so this is every such key, later ones too.
 */
const spentARetry = (retries: GateEventRow['retries']): boolean =>
    typeof retries === 'number' ? retries > 0 : Object.entries(retries ?? {}).some(([key, count]) => !key.includes(':') && count > 0);

/**
 * Fold a window's events, oldest first, into what the gates caught.
 *
 * Needs-human is counted from the flag rather than from what caused it. A cause writes its own event and
 * then a `transition.written`, so counting both would count one flag twice. A redelivered job flags a
 * flagged card again, so a card only counts once until something clears its flag, and a flag raised
 * before the window opened looks new the first time the card is flagged again.
 */
export const foldGateStats = (rows: GateEventRow[]): GateFigures => {
    const kickbacks = new Map<string, ProjectGateKickback>();
    const failures = new Map<FailureClass, { count: number; matched: number }>();
    const revised = new Map<string, number>();
    const touchpoints = new Map<TouchpointCause, number>();
    const challenge = { upheld: 0, overturned: 0 };
    const questions = { asked: 0, answered: 0 };
    let loopStops = 0;
    let matched = 0;
    const difficulties: ProjectGateDifficulty[] = [];

    /** A lane's own `revise` whose transition has not been read yet, which says if a step holds it. */
    const awaitingTransition = new Map<string, string>();
    const flagged = new Set<string>();
    const causes = new Map<string, TouchpointCause>();
    const paidForARetry = new Set<string>();
    const reached = new Set<string>();

    const kickback = (stage: string, step: string | null, reason: ProjectGateKickback['reason'], isMatched: boolean): void => {
        const key = `${stage}\0${step ?? ''}\0${reason}`;
        const row = kickbacks.get(key) ?? { stage, ...(step ? { step } : {}), reason, count: 0, matched: 0 };
        kickbacks.set(key, row);
        row.count += 1;
        if (isMatched) row.matched += 1;
    };

    for (const row of rows) {
        const stage = row.stage ?? '';

        if ((row.type === 'stage.passed' || row.type === 'stage.failed') && row.difficulty && row.createdAt) {
            difficulties.push({ cardId: row.cardId, stage, ...(row.step ? { step: row.step } : {}), note: row.difficulty, at: row.createdAt });
        }

        if (row.type === 'stage.passed' && row.verdict === 'revise') {
            bump(revised, stage);
            if (row.step) {
                kickback(stage, row.step, 'revise', false);
                if (row.step === CHALLENGE_STEP) challenge.upheld += 1;
            } else {
                awaitingTransition.set(row.cardId, stage);
            }
        } else if (row.type === 'stage.passed' && row.step === CHALLENGE_STEP) {
            challenge.overturned += 1;
        } else if (row.type === 'stage.failed') {
            const isLoop = Boolean(row.loopStopped);
            const failureClass =
                (row.failureClass as FailureClass | null) ?? (isLoop ? 'loop' : row.error ? 'error' : matchOlderFailure(row.firstFailure));
            const isMatched = !row.failureClass && !isLoop && !row.error;
            const counted = failures.get(failureClass) ?? { count: 0, matched: 0 };
            failures.set(failureClass, counted);
            counted.count += 1;
            if (isMatched) {
                counted.matched += 1;
                matched += 1;
            }
            if (isLoop) loopStops += 1;
            if (failureClass === 'verifier') kickback(stage, row.step, 'verifier', isMatched);
        } else if (row.type === 'stage.blocked') {
            questions.asked += 1;
        } else if (row.type === 'card.answered') {
            questions.answered += 1;
        }

        const cause = CAUSE_OF[row.type];
        // A dead job poisons the card next, and the death is the more useful of the two to name.
        if (cause && !row.alreadyResolved && !(cause === 'poisoned' && causes.get(row.cardId) === 'dead')) {
            causes.set(row.cardId, cause);
        }

        if (row.type === 'card.acked' || row.type === 'card.answered') flagged.delete(row.cardId);
        // An ack takes the flagged stage's count off the card, so later transitions would not show it.
        if (spentARetry(row.retries)) paidForARetry.add(row.cardId);

        if (row.type !== 'transition.written') continue;

        const heldStage = awaitingTransition.get(row.cardId);
        if (heldStage !== undefined) {
            awaitingTransition.delete(row.cardId);
            if (!row.step) kickback(heldStage, null, 'revise', false);
        }

        if (row.to && REACHED_THE_END.has(row.to)) reached.add(row.cardId);

        if (row.by === 'runner' && (row.needsHuman || row.to === 'poisoned')) {
            if (!flagged.has(row.cardId)) {
                bump(touchpoints, causes.get(row.cardId) ?? flagCause(row));
            }
            causes.delete(row.cardId);
            flagged.add(row.cardId);
        } else if (row.by !== 'runner' && !row.needsHuman) {
            // A person moving a card takes any flag off it.
            flagged.delete(row.cardId);
        }
    }

    // A `revise` with no transition yet is about to send the card back, or failed to and must be looked at.
    for (const [, stage] of awaitingTransition) kickback(stage, null, 'revise', false);

    return {
        kickbacks: [...kickbacks.values()].sort((a, b) => b.count - a.count),
        failures: [...failures].map(([failureClass, counted]) => ({ failureClass, ...counted })).sort((a, b) => b.count - a.count),
        revised: [...revised].map(([stage, count]) => ({ stage, count })),
        challenge,
        questions,
        loopStops,
        touchpoints: [...touchpoints].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count),
        firstPass: { reached: reached.size, firstPass: [...reached].filter(cardId => !paidForARetry.has(cardId)).length },
        matched,
        difficulties: difficulties.reverse().slice(0, MAX_DIFFICULTIES),
    };
};
