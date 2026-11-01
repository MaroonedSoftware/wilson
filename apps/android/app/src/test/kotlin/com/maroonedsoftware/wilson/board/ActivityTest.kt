package com.maroonedsoftware.wilson.board

import com.maroonedsoftware.wilson.sdk.models.ActivityEvent
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private fun event(id: String, title: String? = "A card") =
    ActivityEvent(id = id, type = "stage.passed", stage = "testing", payload = JsonNull, createdAt = Instant.parse("2026-11-01T12:00:00Z"), cardId = "0001", cardTitle = title)

class ActivityTest {
    @Test
    fun theEventsStageIsNamed() {
        assertEquals(ActivitySummary("Failed testing", ActivityTone.BAD), summarizeActivity("stage.failed", "testing", JsonNull))
        assertEquals("Passed a stage", summarizeActivity("stage.passed", null, JsonNull).label)
    }

    @Test
    fun aTransitionIsAMoveOnlyWhenTheStageChanged() {
        val moved = buildJsonObject { put("from", "planning"); put("to", "ready") }
        val same = buildJsonObject { put("from", "ready"); put("to", "ready") }
        assertEquals("Moved to ready", summarizeActivity("transition.written", null, moved).label)
        assertEquals("Updated the card", summarizeActivity("transition.written", null, same).label)
        assertEquals("Updated the card", summarizeActivity("transition.written", null, JsonNull).label)
    }

    @Test
    fun anUnknownTypeShowsAsRecorded() = assertEquals(ActivitySummary("brand.new", ActivityTone.QUIET), summarizeActivity("brand.new", null, JsonNull))

    @Test
    fun aReasonIsReadAndAnythingElseIgnored() {
        assertEquals("tests failed", activityReason(buildJsonObject { put("reason", "tests failed") }))
        assertNull(activityReason(buildJsonObject { put("reason", "") }))
        assertNull(activityReason(buildJsonObject { put("reason", 3) }))
        assertNull(activityReason(JsonPrimitive("reason")))
    }

    @Test
    fun aRefreshKeepsOlderPagesAndAddsNewEventsOnTop() {
        val merged = mergeNewest(listOf(event("3"), event("2"), event("1")), listOf(event("4"), event("3", "Renamed")))
        assertEquals(listOf("4", "3", "2", "1"), merged.map { it.id })
        assertEquals("Renamed", merged[1].cardTitle)
    }

    @Test
    fun aFullPageWithNothingInCommonLeavesAGap() {
        val held = listOf(event("2"), event("1"))
        assertEquals(true, leavesGap(held, listOf(event("9"), event("8")), pageSize = 2))
        assertEquals(false, leavesGap(held, listOf(event("9"), event("2")), pageSize = 2))
        assertEquals(false, leavesGap(held, listOf(event("9")), pageSize = 2))
        assertEquals(false, leavesGap(emptyList(), listOf(event("9"), event("8")), pageSize = 2))
    }

    @Test
    fun theAgeUsesTheFewestWords() {
        assertEquals("now", activityAge(30.seconds))
        assertEquals("now", activityAge((-5).seconds))
        assertEquals("5m", activityAge(5.minutes))
        assertEquals("2h", activityAge(2.hours))
        assertEquals("3d", activityAge(3.days))
    }
}
