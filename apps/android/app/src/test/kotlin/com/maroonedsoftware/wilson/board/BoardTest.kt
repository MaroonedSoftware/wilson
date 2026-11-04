package com.maroonedsoftware.wilson.board

import com.maroonedsoftware.wilson.sdk.models.BoardColumns
import com.maroonedsoftware.wilson.sdk.models.CardSummaryDoneReason
import com.maroonedsoftware.wilson.sdk.models.CardSummaryPlanCheck
import com.maroonedsoftware.wilson.sdk.models.CardSummary
import com.maroonedsoftware.wilson.sdk.models.MergeStatus
import com.maroonedsoftware.wilson.sdk.models.MergeStatusState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private fun card(id: String, stage: String, flagged: Boolean = false, position: Long? = null) =
    CardSummary(id = id, title = id, stage = stage, dependsOn = emptyList(), needsHuman = flagged, position = position)

class BoardTest {
    private fun merge(state: MergeStatusState, conflicts: List<String> = emptyList(), movedUnder: List<String> = emptyList(), reason: String? = null) =
        MergeStatus(state = state, target = "main", conflicts = conflicts, movedUnder = movedUnder, reason = reason)

    @Test
    fun theMergeStatusNamesWhatItWouldHit() {
        assertEquals("Merges cleanly into main.", mergeStatusLine(merge(MergeStatusState.CLEAN)))
        assertEquals("Conflicts with main: a, b", mergeStatusLine(merge(MergeStatusState.CONFLICT, listOf("a", "b"))))
        assertEquals("Conflicts with main.", mergeStatusLine(merge(MergeStatusState.CONFLICT)))
        assertEquals(
            "Merge would send this back to review: main moved under a. It also conflicts: a",
            mergeStatusLine(merge(MergeStatusState.REREVIEW, listOf("a"), listOf("a"))),
        )
        assertEquals(
            "Merge would stop and flag this for a human: main moved under a, and it has used up its re-reviews.",
            mergeStatusLine(merge(MergeStatusState.CAPPED, movedUnder = listOf("a"))),
        )
        assertEquals("Could not check the merge: gone", mergeStatusLine(merge(MergeStatusState.UNKNOWN, reason = "gone")))
    }

    @Test
    fun onlyAMergeThatWouldNotLandWarns() {
        assertEquals(false, mergeStatusWarns(merge(MergeStatusState.CLEAN)))
        assertEquals(false, mergeStatusWarns(merge(MergeStatusState.UNKNOWN)))
        assertEquals(true, mergeStatusWarns(merge(MergeStatusState.CONFLICT)))
        assertEquals(true, mergeStatusWarns(merge(MergeStatusState.REREVIEW)))
        assertEquals(true, mergeStatusWarns(merge(MergeStatusState.CAPPED)))
    }

    @Test
    fun theFlagBeatsTheStage() {
        assertEquals(CardState.NEEDS_HUMAN, cardState(true, "merged"))
        assertEquals(CardState.PARKED, cardState(false, PARKING_LOT))
        assertEquals(CardState.POISONED, cardState(false, "poisoned"))
        assertEquals(CardState.PASSED, cardState(false, "merged"))
        assertEquals(CardState.POISONED, cardState(false, "done", CardSummaryDoneReason.POISONED))
        assertEquals(CardState.PASSED, cardState(false, "done", CardSummaryDoneReason.MERGED))
        assertNull(cardState(false, "done", CardSummaryDoneReason.DROPPED))
        assertNull(cardState(false, "implementing"))
    }

    @Test
    fun aStageTheConfigDoesNotNameIsStillShown() {
        val columns = BoardColumns(stages = listOf("planning", "ready"), nonStages = listOf(PARKING_LOT, "merged"))
        assertEquals(listOf(PARKING_LOT, "planning", "ready", "merged", "zzz"), columnOrder(columns, listOf(card("1", "zzz"), card("2", "ready"))))
    }

    @Test
    fun flaggedCardsLeadTheirColumn() {
        val grouped = groupByStage(listOf(card("0001", "ready"), card("0003", "ready", flagged = true), card("0002", "ready")))
        assertEquals(listOf("0003", "0001", "0002"), grouped.getValue("ready").map { it.id })
    }

    @Test
    fun theParkingLotKeepsTheOperatorsOrder() {
        val grouped = groupByStage(listOf(card("0001", PARKING_LOT), card("0002", PARKING_LOT, position = 2), card("0003", PARKING_LOT, flagged = true, position = 1)))
        assertEquals(listOf("0003", "0002", "0001"), grouped.getValue(PARKING_LOT).map { it.id })
    }

    @Test
    fun aPlanCheckSaysWhereItHasGot() {
        assertNull(planCheckLine(null, null))
        assertEquals("Checking the plan's scope", planCheckLine(CardSummaryPlanCheck.CHECKING, null))
        assertEquals("Scope check refused: too broad", planCheckLine(CardSummaryPlanCheck.REFUSED, "too broad"))
    }
}
