package com.maroonedsoftware.wilson.ui.plan

import com.maroonedsoftware.wilson.sdk.models.PlanTurn
import com.maroonedsoftware.wilson.sdk.models.PlanTurnRole
import org.junit.Assert.assertEquals
import org.junit.Test

private fun turn(seq: Int, role: String = "assistant", text: String = "t$seq") =
    """{"seq":$seq,"role":"$role","content":"$text","createdAt":"2026-10-31T12:00:00Z"}"""

class PlanTranscriptTest {
    @Test
    fun deltasGrowThePendingTextAndTheTurnReplacesIt() {
        var state = PlanState()
        state = applySignal(state, "delta", "Hel")
        state = applySignal(state, "delta", "lo\nthere")
        assertEquals("Hello\nthere", state.pending)
        state = applySignal(state, "turn", turn(1, text = "Hello"))
        assertEquals("", state.pending)
        assertEquals(PlanTurnRole.ASSISTANT, state.turns.single().role)
    }

    @Test
    fun aTurnSeenTwiceShowsOnceAndOrderIsBySeq() {
        var state = PlanState()
        listOf(2, 1, 2).forEach { state = applySignal(state, "turn", turn(it)) }
        assertEquals(listOf(1L, 2L), state.turns.map { it.seq })
    }

    @Test
    fun anUnknownEventChangesNothing() = assertEquals(PlanState(), applySignal(PlanState(), "ping", "{}"))

    @Test
    fun theAskersOwnTurnShowsBesideTheReply() {
        val reply = PlanTurn(seq = 4, role = PlanTurnRole.ASSISTANT, content = "ok", createdAt = PlanStateFixtures.at)
        assertEquals(listOf(3L, 4L), withReply(emptyList(), reply, "why?").map { it.seq })
        assertEquals(listOf(4L), withReply(emptyList(), reply, "").map { it.seq })
    }

    @Test
    fun aReplayedRealTurnIsNotOverwritten() {
        val real = PlanTurn(seq = 3, role = PlanTurnRole.USER, content = "why? (stored)", createdAt = PlanStateFixtures.at)
        val reply = PlanTurn(seq = 4, role = PlanTurnRole.ASSISTANT, content = "ok", createdAt = PlanStateFixtures.at)
        assertEquals("why? (stored)", withReply(listOf(real), reply, "why?").first().content)
    }
}

private object PlanStateFixtures {
    val at = kotlinx.datetime.Instant.parse("2026-10-31T12:00:00Z")
}
