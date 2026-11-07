package com.maroonedsoftware.wilson.ui.goal

import com.maroonedsoftware.wilson.board.ActivityTone
import com.maroonedsoftware.wilson.sdk.models.Goal
import com.maroonedsoftware.wilson.sdk.models.GoalDetail
import com.maroonedsoftware.wilson.sdk.models.GoalStatus
import com.maroonedsoftware.wilson.sdk.models.UpdateGoalRequest
import com.maroonedsoftware.wilson.sdk.runtime.SdkJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The goal screens' rules where they meet the generated serializer: a status the server adds later must
 * decode and draw without crashing, and every button must produce a body the serializer can write.
 */
class GoalWireTest {
    private fun goalJson(id: String, status: String) =
        """{"id":"$id","threadId":"t-$id","project":"p-$id","title":"Goal $id","outcome":"Done when $id is.",""" +
            """"status":"$status","createdAt":"2026-11-07T12:00:00Z","updatedAt":"2026-11-07T12:00:00Z"}"""

    @Test
    fun aStatusTheServerAddsLaterReadsAsUnknownAndOffersNothing() {
        val goal: Goal = SdkJson.decodeFromString(goalJson("1", "archived"))
        assertEquals(GoalStatus.UNKNOWN, goal.status)
        assertEquals("unknown", statusWord(goal.status))
        assertEquals(ActivityTone.QUIET, goalTone(goal.status))
        assertFalse(isOpen(goal.status))
        assertTrue(goalActions(goal.status).isEmpty())
    }

    @Test
    fun statusWordIsWhatTheServerSends() {
        listOf("active", "paused", "done", "abandoned").forEach { wire ->
            val goal: Goal = SdkJson.decodeFromString(goalJson("1", wire))
            assertEquals(wire, statusWord(goal.status))
        }
    }

    @Test
    fun everyActionEncodesToTheStatusWebSends() {
        val sent =
            GoalStatus.entries.associateWith { status ->
                goalActions(status).map { SdkJson.encodeToString(UpdateGoalRequest.serializer(), UpdateGoalRequest(status = it.to)) }
            }
        assertEquals(
            listOf("""{"status":"paused"}""", """{"status":"done"}""", """{"status":"abandoned"}"""),
            sent[GoalStatus.ACTIVE],
        )
        assertEquals(
            listOf("""{"status":"active"}""", """{"status":"done"}""", """{"status":"abandoned"}"""),
            sent[GoalStatus.PAUSED],
        )
        assertEquals(listOf("""{"status":"active"}"""), sent[GoalStatus.DONE])
        assertEquals(listOf("""{"status":"active"}"""), sent[GoalStatus.ABANDONED])
        assertEquals(emptyList<String>(), sent[GoalStatus.UNKNOWN])
    }

    @Test
    fun aDecodedListPartitionsInTheServersOrder() {
        val body =
            listOf(
                goalJson("a", "done"),
                goalJson("b", "active"),
                goalJson("c", "archived"),
                goalJson("d", "paused"),
                goalJson("e", "abandoned"),
            ).joinToString(",", "[", "]")
        val (open, finished) = partitionGoals(SdkJson.decodeFromString<List<Goal>>(body))
        assertEquals(listOf("b", "d"), open.map { it.id })
        assertEquals(listOf("a", "c", "e"), finished.map { it.id })
        assertEquals(listOf("p-b", "p-d"), open.map { it.project })
    }

    @Test
    fun aDetailsCardsKeepTheirOrderAndFlag() {
        val body =
            """{"goal":${goalJson("g", "active")},"cards":[""" +
                """{"id":"0031","title":"Second","stage":"reviewing","needsHuman":true},""" +
                """{"id":"0007","title":"First","stage":"done","needsHuman":false}]}"""
        val detail: GoalDetail = SdkJson.decodeFromString(body)
        assertEquals(listOf("0031", "0007"), detail.cards.map { it.id })
        assertEquals(listOf(true, false), detail.cards.map { it.needsHuman })
        assertEquals(listOf("Pause", "Mark done", "Abandon"), goalActions(detail.goal.status).map { it.label })
    }
}
