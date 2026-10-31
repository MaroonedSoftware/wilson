package com.maroonedsoftware.wilson.board

import com.maroonedsoftware.wilson.sdk.models.BoardColumns
import com.maroonedsoftware.wilson.sdk.models.CardSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private fun card(id: String, stage: String, flagged: Boolean = false, position: Long? = null) =
    CardSummary(id = id, title = id, stage = stage, dependsOn = emptyList(), needsHuman = flagged, position = position)

class BoardTest {
    @Test
    fun theFlagBeatsTheStage() {
        assertEquals(CardState.NEEDS_HUMAN, cardState(true, "merged"))
        assertEquals(CardState.PARKED, cardState(false, PARKING_LOT))
        assertEquals(CardState.POISONED, cardState(false, "poisoned"))
        assertEquals(CardState.PASSED, cardState(false, "merged"))
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
}
