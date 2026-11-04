package com.maroonedsoftware.wilson.ui.chat

import com.maroonedsoftware.wilson.sdk.models.ChatMessage
import com.maroonedsoftware.wilson.sdk.models.ChatMessageRole
import com.maroonedsoftware.wilson.sdk.models.ChatPendingAction
import com.maroonedsoftware.wilson.sdk.models.ChatPendingActionStatus
import kotlin.time.Instant
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val NOW = Instant.parse("2026-10-31T12:00:00Z")

private const val LATER = "2026-10-31T12:05:00Z"
private const val EARLIER = "2026-10-31T11:55:00Z"

private fun action(status: ChatPendingActionStatus, expires: String, id: String = "a", at: Instant = NOW) = ChatPendingAction(
    id = id, threadId = "t", operation = "moveCard", arguments = JsonNull, summary = "Move it", status = status,
    expiresAt = Instant.parse(expires), createdAt = at,
)

private fun proposedAt(id: String, minute: Int) = action(ChatPendingActionStatus.PENDING, LATER, id, at(minute))

private fun message(seq: Long, role: ChatMessageRole, minute: Int) = ChatMessage(seq, role, "said", emptyList(), at(minute))

private fun at(minute: Int) = Instant.parse("2026-10-31T12:%02d:00Z".format(minute))

/** Which entries came out, in order: `m` and a message's seq, `a` and an action's id. */
private fun order(messages: List<ChatMessage>, actions: List<ChatPendingAction>) = timeline(messages, actions).map { it.key }

class ChatTest {
    @Test
    fun theSuggestionsBlockIsTakenOff() = assertEquals("Done.", draftWithoutSuggestions("Done.\n\n<suggestions>\nnext\n</suggestions>"))

    @Test
    fun whatMayBeTheBlockStartingIsHeldBack() = assertEquals("Done.", draftWithoutSuggestions("Done.\n<sugg"))

    @Test
    fun anUnrelatedAngleBracketIsKept() = assertEquals("1 < 2", draftWithoutSuggestions("1 < 2"))

    @Test
    fun aMessagesImagesAreCounted() {
        assertEquals(null, imagesCaption(0))
        assertEquals("1 image", imagesCaption(1))
        assertEquals("3 images", imagesCaption(3))
    }

    @Test
    fun onlyAPendingUnexpiredActionCanBeAnswered() {
        assertTrue(isAwaiting(action(ChatPendingActionStatus.PENDING, "2026-10-31T12:05:00Z"), NOW))
        assertFalse(isAwaiting(action(ChatPendingActionStatus.PENDING, "2026-10-31T11:55:00Z"), NOW))
        assertFalse(isAwaiting(action(ChatPendingActionStatus.DONE, "2026-10-31T12:05:00Z"), NOW))
    }

    @Test
    fun aWaitingActionHasNoOutcomeYet() = assertNull(actionOutcome(action(ChatPendingActionStatus.PENDING, LATER), NOW))

    @Test
    fun aPendingActionPastItsExpiryReadsAsExpired() = assertEquals("expired", actionOutcome(action(ChatPendingActionStatus.PENDING, EARLIER), NOW))

    @Test
    fun aDecidedActionSaysHowItWentWhateverItsExpiry() {
        val expected = mapOf(
            ChatPendingActionStatus.RUNNING to "running",
            ChatPendingActionStatus.DONE to "done",
            ChatPendingActionStatus.FAILED to "failed",
            ChatPendingActionStatus.DECLINED to "declined",
            ChatPendingActionStatus.UNKNOWN to "unknown",
        )
        expected.forEach { (status, label) ->
            assertEquals(label, actionOutcome(action(status, LATER), NOW))
            assertEquals(label, actionOutcome(action(status, EARLIER), NOW))
        }
    }

    @Test
    fun everyActionStaysInTheConversationWhateverItsStatus() {
        val actions = ChatPendingActionStatus.entries.mapIndexed { index, status -> action(status, EARLIER, "a$index") }
        assertEquals(actions.size, timeline(emptyList(), actions).size)
    }

    @Test
    fun anActionFollowsTheAnswerOfTheTurnThatProposedIt() {
        val messages = listOf(message(1, ChatMessageRole.USER, 0), message(2, ChatMessageRole.ASSISTANT, 2))
        assertEquals(listOf("m1", "m2", "aa"), order(messages, listOf(proposedAt("a", 1))))
    }

    @Test
    fun anActionStaysLastWhileItsTurnIsStillRunning() {
        assertEquals(listOf("m1", "aa"), order(listOf(message(1, ChatMessageRole.USER, 0)), listOf(proposedAt("a", 1))))
    }

    @Test
    fun aLaterFollowUpGoesBelowTheAction() {
        val messages = listOf(message(1, ChatMessageRole.USER, 0), message(2, ChatMessageRole.ASSISTANT, 2), message(3, ChatMessageRole.ASSISTANT, 4))
        assertEquals(listOf("m1", "m2", "aa", "m3"), order(messages, listOf(proposedAt("a", 1))))
    }

    @Test
    fun anActionWhoseTurnStoredNoAnswerStaysAboveTheNextMessage() {
        val messages = listOf(message(1, ChatMessageRole.USER, 0), message(2, ChatMessageRole.USER, 2), message(3, ChatMessageRole.ASSISTANT, 3))
        assertEquals(listOf("m1", "aa", "m2", "m3"), order(messages, listOf(proposedAt("a", 1))))
    }

    @Test
    fun actionsOfOneTurnKeepTheirOrder() {
        val messages = listOf(message(1, ChatMessageRole.USER, 0), message(2, ChatMessageRole.ASSISTANT, 3))
        assertEquals(listOf("m1", "m2", "aa", "ab"), order(messages, listOf(proposedAt("b", 2), proposedAt("a", 1))))
    }
}
