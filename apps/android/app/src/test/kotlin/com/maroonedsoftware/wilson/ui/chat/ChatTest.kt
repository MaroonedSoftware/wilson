package com.maroonedsoftware.wilson.ui.chat

import com.maroonedsoftware.wilson.sdk.models.ChatPendingAction
import com.maroonedsoftware.wilson.sdk.models.ChatPendingActionStatus
import kotlin.time.Instant
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private val NOW = Instant.parse("2026-10-31T12:00:00Z")

private fun action(status: ChatPendingActionStatus, expires: String) = ChatPendingAction(
    id = "a", threadId = "t", operation = "moveCard", arguments = JsonNull, summary = "Move it", status = status,
    expiresAt = Instant.parse(expires), createdAt = NOW,
)

class ChatTest {
    @Test
    fun theSuggestionsBlockIsTakenOff() = assertEquals("Done.", draftWithoutSuggestions("Done.\n\n<suggestions>\nnext\n</suggestions>"))

    @Test
    fun whatMayBeTheBlockStartingIsHeldBack() = assertEquals("Done.", draftWithoutSuggestions("Done.\n<sugg"))

    @Test
    fun anUnrelatedAngleBracketIsKept() = assertEquals("1 < 2", draftWithoutSuggestions("1 < 2"))

    @Test
    fun onlyAPendingUnexpiredActionCanBeAnswered() {
        assertTrue(isAwaiting(action(ChatPendingActionStatus.PENDING, "2026-10-31T12:05:00Z"), NOW))
        assertFalse(isAwaiting(action(ChatPendingActionStatus.PENDING, "2026-10-31T11:55:00Z"), NOW))
        assertFalse(isAwaiting(action(ChatPendingActionStatus.DONE, "2026-10-31T12:05:00Z"), NOW))
    }
}
