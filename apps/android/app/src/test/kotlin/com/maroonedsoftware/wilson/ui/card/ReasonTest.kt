package com.maroonedsoftware.wilson.ui.card

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReasonTest {
    @Test
    fun theDetailedReasonWins() =
        assertEquals("dependency 0002 is not merged", reasonIn(Json.parseToJsonElement("""{"message":"Conflict","details":{"reason":"dependency 0002 is not merged"}}""")))

    @Test
    fun theMessageIsTheFallback() = assertEquals("Conflict", reasonIn(Json.parseToJsonElement("""{"message":"Conflict"}""")))

    @Test
    fun aBodyThatIsNotJsonHasNone() = assertNull(reasonIn(null))

    @Test
    fun theFeedNamesItsCard() {
        assertEquals("0007", feedCardId("""{"id":1,"correlationId":"0007"}"""))
        assertNull(feedCardId("nonsense"))
    }
}

class MergeMessageTest {
    @Test
    fun aLandedMergeNamesItsCommit() = assertEquals("Landed on main as abcdef12.", mergeMessage(MergeOutcome.Landed("abcdef1234567")))

    @Test
    fun aRefusalIsTheServersOwn() = assertEquals("tests failed", mergeMessage(MergeOutcome.Refused("tests failed")))

    @Test
    fun aLostAnswerNeverClaimsEitherWay() = assertEquals(true, "may still have landed" in mergeMessage(MergeOutcome.Unknown))
}
