package com.maroonedsoftware.wilson.ui.chat

import com.maroonedsoftware.wilson.sdk.models.AnswerChatQuestionsRequest
import com.maroonedsoftware.wilson.sdk.models.ChatMessage
import com.maroonedsoftware.wilson.sdk.models.ChatMessageRole
import com.maroonedsoftware.wilson.sdk.models.ChatPendingAction
import com.maroonedsoftware.wilson.sdk.models.ChatPendingActionStatus
import com.maroonedsoftware.wilson.sdk.models.ChatPendingQuestion
import com.maroonedsoftware.wilson.sdk.models.ChatPendingQuestionStatus
import com.maroonedsoftware.wilson.sdk.models.ChatQuestion
import com.maroonedsoftware.wilson.sdk.models.ChatQuestionAnswer
import com.maroonedsoftware.wilson.sdk.models.ChatQuestionOption
import com.maroonedsoftware.wilson.sdk.runtime.SdkJson
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

    @Test
    fun aQuestionFollowsTheAnswerOfTheTurnThatAskedIt() {
        val messages = listOf(message(1, ChatMessageRole.USER, 0), message(2, ChatMessageRole.ASSISTANT, 2), message(3, ChatMessageRole.USER, 5))
        assertEquals(listOf("m1", "m2", "qq", "m3"), timeline(messages, emptyList(), listOf(askedAt("q", 1))).map { it.key })
    }

    @Test
    fun actionsAndQuestionsOfOneTurnKeepTheOrderTheyWereRaisedIn() {
        val messages = listOf(message(1, ChatMessageRole.USER, 0), message(2, ChatMessageRole.ASSISTANT, 4))
        val keys = timeline(messages, listOf(proposedAt("a", 3), proposedAt("b", 1)), listOf(askedAt("q", 2))).map { it.key }
        assertEquals(listOf("m1", "m2", "ab", "qq", "aa"), keys)
    }

    @Test
    fun aQuestionStaysLastWhileItsTurnIsStillRunning() {
        assertEquals(listOf("m1", "qq"), timeline(listOf(message(1, ChatMessageRole.USER, 0)), emptyList(), listOf(askedAt("q", 1))).map { it.key })
    }

    @Test
    fun onlyAPendingUnexpiredQuestionCanBeAnswered() {
        assertTrue(isUnanswered(asked(ChatPendingQuestionStatus.PENDING, LATER), NOW))
        assertFalse(isUnanswered(asked(ChatPendingQuestionStatus.PENDING, EARLIER), NOW))
        assertFalse(isUnanswered(asked(ChatPendingQuestionStatus.ANSWERED, LATER), NOW))
        assertNull(questionOutcome(asked(ChatPendingQuestionStatus.PENDING, LATER), NOW))
        assertEquals("expired", questionOutcome(asked(ChatPendingQuestionStatus.PENDING, EARLIER), NOW))
        assertEquals("answered", questionOutcome(asked(ChatPendingQuestionStatus.ANSWERED, LATER), NOW))
        assertEquals("dismissed", questionOutcome(asked(ChatPendingQuestionStatus.DISMISSED, LATER), NOW))
    }

    @Test
    fun submitWaitsUntilEveryQuestionHasAChoiceOrOtherText() {
        var draft = QuestionDraft.empty(TWO)
        assertFalse(draft.complete)
        draft = draft.choose(TWO, 0, 1)
        assertFalse(draft.complete)
        draft = draft.type(TWO, 1, "   ")
        assertFalse(draft.complete)
        draft = draft.type(TWO, 1, " my own ")
        assertTrue(draft.complete)
    }

    @Test
    fun untickingTheOnlyChoiceOfAMultipleChoiceLeavesItUnanswered() {
        val draft = QuestionDraft.empty(TWO).choose(TWO, 0, 0).type(TWO, 1, "x").choose(TWO, 1, 0).choose(TWO, 1, 0).type(TWO, 1, "")
        assertFalse(draft.complete)
    }

    @Test
    fun aSingleChoiceIsOneAnswer() {
        val typed = QuestionDraft.empty(TWO).choose(TWO, 0, 1).type(TWO, 0, "else")
        assertEquals(emptySet<Int>(), typed.chosen[0])
        val picked = typed.choose(TWO, 0, 0)
        assertEquals(setOf(0), picked.chosen[0])
        assertEquals("", picked.other[0])
    }

    @Test
    fun aMultipleChoiceKeepsItsOtherTextBesideTheOptions() {
        val draft = QuestionDraft.empty(TWO).choose(TWO, 1, 2).choose(TWO, 1, 0).type(TWO, 1, "also this")
        assertEquals(setOf(0, 2), draft.chosen[1])
        assertEquals("also this", draft.other[1])
    }

    @Test
    fun otherTextIsCutAtTheApisLimit() {
        assertEquals(MAX_OTHER_LENGTH, QuestionDraft.empty(TWO).type(TWO, 0, "x".repeat(MAX_OTHER_LENGTH + 20)).other[0].length)
    }

    @Test
    fun theAnswersAreSentAsWebSendsThem() {
        val draft = QuestionDraft.empty(TWO).choose(TWO, 0, 1).choose(TWO, 1, 2).choose(TWO, 1, 0).type(TWO, 1, "  and more  ")
        val body = SdkJson.encodeToString(AnswerChatQuestionsRequest.serializer(), AnswerChatQuestionsRequest(draft.answers()))
        assertEquals("""{"answers":[{"chosen":[1]},{"chosen":[0,2],"other":"and more"}]}""", body)
    }

    @Test
    fun anAnsweredQuestionReadsAsWhatWasChosen() {
        assertEquals("Postgres", answerText(TWO[0], ChatQuestionAnswer(listOf(1))))
        assertEquals("A, C, mine", answerText(TWO[1], ChatQuestionAnswer(listOf(0, 2), "mine")))
        assertNull(answerText(TWO[0], null))
    }
}

private fun options(vararg labels: String) = labels.map { ChatQuestionOption(it, "") }

private val TWO = listOf(
    ChatQuestion("Database", "Which one?", options("SQLite", "Postgres"), multiSelect = false),
    ChatQuestion("Extras", "Which ones?", options("A", "B", "C"), multiSelect = true),
)

private fun asked(status: ChatPendingQuestionStatus, expires: String, id: String = "q", at: Instant = NOW) = ChatPendingQuestion(
    id = id, threadId = "t", questions = TWO, status = status, expiresAt = Instant.parse(expires), createdAt = at,
)

private fun askedAt(id: String, minute: Int) = asked(ChatPendingQuestionStatus.PENDING, LATER, id, at(minute))
