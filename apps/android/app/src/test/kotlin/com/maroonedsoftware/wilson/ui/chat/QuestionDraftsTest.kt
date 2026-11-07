package com.maroonedsoftware.wilson.ui.chat

import com.maroonedsoftware.wilson.sdk.models.ChatPendingQuestion
import com.maroonedsoftware.wilson.sdk.models.ChatPendingQuestionStatus
import com.maroonedsoftware.wilson.sdk.models.ChatQuestion
import com.maroonedsoftware.wilson.sdk.models.ChatQuestionOption
import kotlin.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private val DRAFT_NOW = Instant.parse("2026-11-07T12:00:00Z")

private val DRAFT_SOON = Instant.parse("2026-11-07T12:05:00Z")

private val DRAFT_QUESTIONS = listOf(
    ChatQuestion("Database", "Which one?", listOf("SQLite", "Postgres").map { ChatQuestionOption(it, "") }, multiSelect = false),
    ChatQuestion("Extras", "Which ones?", listOf("A", "B", "C").map { ChatQuestionOption(it, "") }, multiSelect = true),
)

private fun draftQuestion(
    id: String,
    expires: Instant = DRAFT_SOON,
    status: ChatPendingQuestionStatus = ChatPendingQuestionStatus.PENDING,
) = ChatPendingQuestion(id = id, threadId = "t", questions = DRAFT_QUESTIONS, status = status, expiresAt = expires, createdAt = DRAFT_NOW)

/** The draft rules [ChatModel] applies on every edit and every thread read, which is what keeps a draft across a rotation. */
class QuestionDraftsTest {
    private val halfAnswered = QuestionDraft.empty(DRAFT_QUESTIONS)
        .choose(DRAFT_QUESTIONS, 0, 1)
        .choose(DRAFT_QUESTIONS, 1, 0)
        .choose(DRAFT_QUESTIONS, 1, 2)
        .type(DRAFT_QUESTIONS, 1, "and a bit more")

    @Test
    fun aRebuiltCardShowsTheChoicesAndOtherTextHeldForItsQuestion() {
        val shown = mapOf("q" to halfAnswered).draftFor(draftQuestion("q"))
        assertEquals(listOf(setOf(1), setOf(0, 2)), shown.chosen)
        assertEquals(listOf("", "and a bit more"), shown.other)
    }

    @Test
    fun anotherQuestionsCardDoesNotPickUpTheDraft() {
        assertEquals(QuestionDraft.empty(DRAFT_QUESTIONS), mapOf("q1" to halfAnswered).draftFor(draftQuestion("q2")))
    }

    @Test
    fun repeatedReloadsKeepAPendingDraftThenAnAnswerDropsIt() {
        var drafts = mapOf("q" to halfAnswered)
        repeat(3) { drafts = drafts.keptFor(listOf(draftQuestion("q")), DRAFT_NOW) }
        assertEquals(halfAnswered, drafts.draftFor(draftQuestion("q")))

        drafts = drafts.keptFor(listOf(draftQuestion("q", status = ChatPendingQuestionStatus.ANSWERED)), DRAFT_NOW)
        assertTrue(drafts.isEmpty())
        assertEquals(QuestionDraft.empty(DRAFT_QUESTIONS), drafts.draftFor(draftQuestion("q")))
    }

    @Test
    fun aDraftIsDroppedAtTheMomentItsQuestionExpires() {
        val drafts = mapOf("q" to halfAnswered)
        assertEquals(drafts, drafts.keptFor(listOf(draftQuestion("q", expires = Instant.parse("2026-11-07T12:00:01Z"))), DRAFT_NOW))
        assertTrue(drafts.keptFor(listOf(draftQuestion("q", expires = DRAFT_NOW)), DRAFT_NOW).isEmpty())
    }

    @Test
    fun aDraftIsDroppedForAQuestionInAnUnknownState() {
        val drafts = mapOf("q" to halfAnswered)
        assertTrue(drafts.keptFor(listOf(draftQuestion("q", status = ChatPendingQuestionStatus.UNKNOWN)), DRAFT_NOW).isEmpty())
    }

    @Test
    fun aDraftIsDroppedOnceTheQuestionExpiresWhileTheThreadIsUnchanged() {
        val questions = listOf(draftQuestion("q"))
        val drafts = mapOf("q" to halfAnswered)
        assertEquals(drafts, drafts.keptFor(questions, DRAFT_NOW))
        assertTrue(drafts.keptFor(questions, Instant.parse("2026-11-07T12:10:00Z")).isEmpty())
    }
}
