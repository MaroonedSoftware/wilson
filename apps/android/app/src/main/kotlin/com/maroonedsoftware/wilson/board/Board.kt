package com.maroonedsoftware.wilson.board

import com.maroonedsoftware.wilson.sdk.models.BoardColumns
import com.maroonedsoftware.wilson.sdk.models.CardSummary
import com.maroonedsoftware.wilson.sdk.models.CardSummaryDoneReason
import com.maroonedsoftware.wilson.sdk.models.CardSummaryPlanCheck

const val PARKING_LOT = "parking-lot"

/** `brand/states`, one for each state a card can be seen to be in. */
enum class CardState { PARKED, PASSED, NEEDS_HUMAN, POISONED }

/** Where an approved plan's scope check has got to, in words, or null when there is no check. */
fun planCheckLine(check: CardSummaryPlanCheck?, reason: String?): String? =
    when (check) {
        CardSummaryPlanCheck.CHECKING -> "Checking the plan's scope"
        CardSummaryPlanCheck.REFUSED -> "Scope check refused: $reason"
        else -> null
    }

/** The same rule as the web board's `cardState`. A card that matches none has no icon. */
fun cardState(needsHuman: Boolean, stage: String, doneReason: CardSummaryDoneReason? = null): CardState? =
    when {
        needsHuman -> CardState.NEEDS_HUMAN
        stage == PARKING_LOT -> CardState.PARKED
        doneReason == CardSummaryDoneReason.POISONED || stage == "poisoned" -> CardState.POISONED
        doneReason == CardSummaryDoneReason.MERGED || stage == "merged" -> CardState.PASSED
        else -> null
    }

/**
 * The columns in order: parking lot, configured stages, terminal states. A stage a card sits in that
 * the config does not name is appended, because a card that appears nowhere is a board quietly
 * disagreeing with the database.
 */
fun columnOrder(columns: BoardColumns, cards: List<CardSummary>): List<String> {
    val known = listOf(PARKING_LOT) + columns.stages + columns.nonStages.filter { it != PARKING_LOT }
    return known + cards.map { it.stage }.distinct().filter { it !in known }.sorted()
}

/**
 * Cards per column, flagged first and then by id. The parking lot keeps the operator's own order
 * instead: lowest `position` first, with unpositioned cards after, by id.
 */
fun groupByStage(cards: List<CardSummary>): Map<String, List<CardSummary>> =
    cards.groupBy { it.stage }.mapValues { (stage, inStage) ->
        if (stage == PARKING_LOT) {
            inStage.sortedWith(compareBy<CardSummary, Long?>(nullsLast()) { it.position }.thenBy { it.id })
        } else {
            inStage.sortedWith(compareByDescending<CardSummary> { it.needsHuman }.thenBy { it.id })
        }
    }
