package com.maroonedsoftware.wilson.ui.goal

import com.maroonedsoftware.wilson.board.ActivityTone
import com.maroonedsoftware.wilson.sdk.models.Goal
import com.maroonedsoftware.wilson.sdk.models.GoalStatus
import com.maroonedsoftware.wilson.sdk.models.UpdateGoalRequestStatus
import kotlin.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private val AT = Instant.parse("2026-11-07T12:00:00Z")

private fun goal(id: String, status: GoalStatus) = Goal(
    id = id, threadId = "t-$id", project = "wilson", title = "Goal $id", outcome = "Done when $id is done.", status = status,
    createdAt = AT, updatedAt = AT,
)

class GoalTest {
    @Test
    fun activeAndPausedAreOpen() {
        assertTrue(isOpen(GoalStatus.ACTIVE))
        assertTrue(isOpen(GoalStatus.PAUSED))
        assertFalse(isOpen(GoalStatus.DONE))
        assertFalse(isOpen(GoalStatus.ABANDONED))
        assertFalse(isOpen(GoalStatus.UNKNOWN))
    }

    @Test
    fun statusWordIsTheWireSpelling() {
        assertEquals("active", statusWord(GoalStatus.ACTIVE))
        assertEquals("paused", statusWord(GoalStatus.PAUSED))
        assertEquals("done", statusWord(GoalStatus.DONE))
        assertEquals("abandoned", statusWord(GoalStatus.ABANDONED))
        assertEquals("unknown", statusWord(GoalStatus.UNKNOWN))
    }

    @Test
    fun tonesComeFromTheAppsOwnSet() {
        assertEquals(ActivityTone.GOOD, goalTone(GoalStatus.ACTIVE))
        assertEquals(ActivityTone.WARNING, goalTone(GoalStatus.PAUSED))
        assertEquals(ActivityTone.INFO, goalTone(GoalStatus.DONE))
        assertEquals(ActivityTone.QUIET, goalTone(GoalStatus.ABANDONED))
        assertEquals(ActivityTone.QUIET, goalTone(GoalStatus.UNKNOWN))
    }

    @Test
    fun partitionKeepsTheServersOrderWithinEachHalf() {
        val goals = listOf(
            goal("1", GoalStatus.DONE),
            goal("2", GoalStatus.ACTIVE),
            goal("3", GoalStatus.UNKNOWN),
            goal("4", GoalStatus.PAUSED),
            goal("5", GoalStatus.ABANDONED),
            goal("6", GoalStatus.ACTIVE),
        )
        val (open, finished) = partitionGoals(goals)
        assertEquals(listOf("2", "4", "6"), open.map { it.id })
        assertEquals(listOf("1", "3", "5"), finished.map { it.id })
    }

    @Test
    fun partitionOfOnlyOpenGoalsLeavesNothingFinished() {
        val (open, finished) = partitionGoals(listOf(goal("1", GoalStatus.ACTIVE)))
        assertEquals(listOf("1"), open.map { it.id })
        assertTrue(finished.isEmpty())
    }

    @Test
    fun actionsMatchWhatWebOffers() {
        assertEquals(
            listOf(
                Triple(UpdateGoalRequestStatus.PAUSED, "Pause", "Paused."),
                Triple(UpdateGoalRequestStatus.DONE, "Mark done", "Marked done."),
                Triple(UpdateGoalRequestStatus.ABANDONED, "Abandon", "Abandoned."),
            ),
            goalActions(GoalStatus.ACTIVE).map { Triple(it.to, it.label, it.done) },
        )
        assertEquals(
            listOf(
                Triple(UpdateGoalRequestStatus.ACTIVE, "Resume", "Resumed."),
                Triple(UpdateGoalRequestStatus.DONE, "Mark done", "Marked done."),
                Triple(UpdateGoalRequestStatus.ABANDONED, "Abandon", "Abandoned."),
            ),
            goalActions(GoalStatus.PAUSED).map { Triple(it.to, it.label, it.done) },
        )
        val reopen = listOf(Triple(UpdateGoalRequestStatus.ACTIVE, "Reopen", "Reopened."))
        assertEquals(reopen, goalActions(GoalStatus.DONE).map { Triple(it.to, it.label, it.done) })
        assertEquals(reopen, goalActions(GoalStatus.ABANDONED).map { Triple(it.to, it.label, it.done) })
    }

    @Test
    fun anUnknownStatusOffersNoActions() {
        assertTrue(goalActions(GoalStatus.UNKNOWN).isEmpty())
    }

    @Test
    fun noActionEverSendsUnknown() {
        GoalStatus.entries.forEach { status ->
            assertTrue(goalActions(status).none { it.to == UpdateGoalRequestStatus.UNKNOWN })
        }
    }
}
