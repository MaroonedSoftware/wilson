package com.maroonedsoftware.wilson.ui.chat

import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.StreamSignal
import com.maroonedsoftware.wilson.auth.liveStream
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.net.Patience
import com.maroonedsoftware.wilson.sdk.models.AnswerChatQuestionsRequest
import com.maroonedsoftware.wilson.sdk.models.ChatMessage
import com.maroonedsoftware.wilson.sdk.models.ChatMessageRole
import com.maroonedsoftware.wilson.sdk.models.ChatPendingAction
import com.maroonedsoftware.wilson.sdk.models.ChatPendingActionStatus
import com.maroonedsoftware.wilson.sdk.models.ChatPendingQuestion
import com.maroonedsoftware.wilson.sdk.models.ChatPendingQuestionStatus
import com.maroonedsoftware.wilson.sdk.models.ChatQuestion
import com.maroonedsoftware.wilson.sdk.models.ChatQuestionAnswer
import com.maroonedsoftware.wilson.sdk.models.ChatThread
import com.maroonedsoftware.wilson.sdk.models.DecideChatActionRequest
import com.maroonedsoftware.wilson.sdk.models.DecideChatActionRequestDecision
import com.maroonedsoftware.wilson.sdk.models.SendChatMessageRequest
import com.maroonedsoftware.wilson.ui.card.reasonFor
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val SUGGESTIONS_OPEN = "<suggestions>"

/**
 * An answer as it streams, without the follow-ups block the agent ends it on. The API takes that off
 * the stored answer; a trailing piece that may be the block starting is held back until it is clearly
 * not. The same rule as the web app's `draftWithoutSuggestions`.
 */
internal fun draftWithoutSuggestions(draft: String): String {
    val start = draft.lowercase().indexOf(SUGGESTIONS_OPEN)
    if (start != -1) return draft.substring(0, start).trimEnd()
    val lt = draft.lastIndexOf('<')
    if (lt != -1 && SUGGESTIONS_OPEN.startsWith(draft.substring(lt).lowercase())) return draft.substring(0, lt).trimEnd()
    return draft
}

/** Whether a proposed action can still be answered. An expired one stays on record as it was. */
internal fun isAwaiting(action: ChatPendingAction, now: Instant): Boolean = action.status == ChatPendingActionStatus.PENDING && action.expiresAt > now

/** How an action went, for its card. Null while it still waits on the person; past its expiry the server would refuse it, so it reads as expired though it is stored as pending. */
internal fun actionOutcome(action: ChatPendingAction, now: Instant): String? = when (action.status) {
    ChatPendingActionStatus.PENDING -> if (isAwaiting(action, now)) null else "expired"
    ChatPendingActionStatus.RUNNING -> "running"
    ChatPendingActionStatus.DONE -> "done"
    ChatPendingActionStatus.FAILED -> "failed"
    ChatPendingActionStatus.DECLINED -> "declined"
    ChatPendingActionStatus.UNKNOWN -> "unknown"
}

/**
 * The longest the person's free-text "Other" answer may be. The source of truth is `MAX_OTHER_LENGTH` in
 * `apps/api/src/modules/chat/chat.questions.ts`, which this app cannot import; the web app keeps its own copy too.
 */
internal const val MAX_OTHER_LENGTH = 500

/** Whether a question still waits on the person: past its expiry the server would refuse an answer. */
internal fun isUnanswered(question: ChatPendingQuestion, now: Instant): Boolean =
    question.status == ChatPendingQuestionStatus.PENDING && question.expiresAt > now

/** How a question went, for its card. Null while it still waits on the person; past its expiry it reads as expired though it is stored as pending. */
internal fun questionOutcome(question: ChatPendingQuestion, now: Instant): String? = when (question.status) {
    ChatPendingQuestionStatus.PENDING -> if (isUnanswered(question, now)) null else "expired"
    ChatPendingQuestionStatus.ANSWERED -> "answered"
    ChatPendingQuestionStatus.DISMISSED -> "dismissed"
    ChatPendingQuestionStatus.UNKNOWN -> "unknown"
}

/** The given answer as it reads in the conversation: the chosen labels, then any "Other" text, joined. Null when there is none. As web's `answerText`. */
internal fun answerText(question: ChatQuestion, given: ChatQuestionAnswer?): String? {
    if (given == null) return null
    val labels = given.chosen.mapNotNull { question.options.getOrNull(it.toInt())?.label }
    val parts = labels + listOfNotNull(given.other?.takeIf { it.isNotEmpty() })
    return parts.takeIf { it.isNotEmpty() }?.joinToString(", ")
}

/**
 * What the person has picked so far on one question card: per question, the options ticked by index and
 * the "Other" text. The same rules as web's `ChatQuestionCard`: a single choice is one answer, so picking an
 * option clears "Other" and typing "Other" clears the option; "Other" is cut at [MAX_OTHER_LENGTH].
 */
internal data class QuestionDraft(val chosen: List<Set<Int>>, val other: List<String>) {
    /** Ticks or unticks [option] on question [index]; on a single choice it replaces whatever was picked. */
    fun choose(questions: List<ChatQuestion>, index: Int, option: Int): QuestionDraft {
        if (!questions[index].multiSelect) return copy(chosen = chosen.replaced(index, setOf(option)), other = other.replaced(index, ""))
        val now = chosen[index]
        return copy(chosen = chosen.replaced(index, if (option in now) now - option else now + option))
    }

    /** Sets question [index]'s "Other" text, cut to [MAX_OTHER_LENGTH]; on a single choice, text replaces the option picked. */
    fun type(questions: List<ChatQuestion>, index: Int, text: String): QuestionDraft {
        val typed = text.take(MAX_OTHER_LENGTH)
        val picked = if (!questions[index].multiSelect && typed.isNotBlank()) chosen.replaced(index, emptySet()) else chosen
        return copy(chosen = picked, other = other.replaced(index, typed))
    }

    /** Whether Submit may be pressed: every question has a choice or non-blank "Other" text. */
    val complete: Boolean get() = chosen.indices.all { chosen[it].isNotEmpty() || other[it].isNotBlank() }

    /** The request body, one answer per question in order: indexes ascending, "Other" trimmed and left out when blank. */
    fun answers(): List<ChatQuestionAnswer> = chosen.indices.map { i ->
        ChatQuestionAnswer(chosen[i].sorted().map { it.toLong() }, other[i].trim().takeIf { it.isNotEmpty() })
    }

    companion object {
        /** Nothing picked on any of [questions]. */
        fun empty(questions: List<ChatQuestion>) = QuestionDraft(questions.map { emptySet() }, questions.map { "" })
    }
}

/** The draft on [question]'s card: what the person has picked so far, or nothing picked. */
internal fun Map<String, QuestionDraft>.draftFor(question: ChatPendingQuestion): QuestionDraft = this[question.id] ?: QuestionDraft.empty(question.questions)

/**
 * The drafts still worth holding: only those whose question is in [questions] and still waits on the person.
 * One answered, dismissed or expired loses its draft; one still pending keeps it, however often the thread is read.
 */
internal fun Map<String, QuestionDraft>.keptFor(questions: List<ChatPendingQuestion>, now: Instant): Map<String, QuestionDraft> {
    val waiting = questions.filter { isUnanswered(it, now) }.mapTo(HashSet<String>()) { it.id }
    return filterKeys { it in waiting }
}

private fun <T> List<T>.replaced(index: Int, value: T): List<T> = mapIndexed { i, entry -> if (i == index) value else entry }

/** One thing in a conversation, in the order [timeline] puts them. */
internal sealed interface ChatEntry {
    val key: String

    data class Said(val message: ChatMessage) : ChatEntry {
        override val key get() = "m${message.seq}"
    }

    data class Proposal(val action: ChatPendingAction) : ChatEntry {
        override val key get() = "a${action.id}"
    }

    data class Asked(val question: ChatPendingQuestion) : ChatEntry {
        override val key get() = "q${question.id}"
    }
}

/**
 * Messages, actions and questions in the order they happened, except that an action or question follows
 * the answer of the turn that raised it. It is stored while the turn runs and the answer only at the end,
 * so by time alone it would sit above that answer, off a phone's screen, and move when the answer arrived.
 * Here it stays last, and a decided card does not jump away from the button just pressed. The web app
 * sorts by time alone.
 */
internal fun timeline(
    messages: List<ChatMessage>,
    actions: List<ChatPendingAction>,
    questions: List<ChatPendingQuestion> = emptyList(),
): List<ChatEntry> {
    val raised: List<Pair<Instant, ChatEntry>> = actions.map { it.createdAt to ChatEntry.Proposal(it) } + questions.map { it.createdAt to ChatEntry.Asked(it) }
    val waiting = ArrayDeque(raised.sortedBy { it.first })
    val entries = mutableListOf<ChatEntry>()
    fun takeRaisedUpTo(at: Instant) {
        while (waiting.firstOrNull()?.let { it.first <= at } == true) entries += waiting.removeFirst().second
    }
    messages.forEach { message ->
        if (message.role == ChatMessageRole.USER) takeRaisedUpTo(message.createdAt)
        entries += ChatEntry.Said(message)
        if (message.role != ChatMessageRole.USER) takeRaisedUpTo(message.createdAt)
    }
    waiting.mapTo(entries) { it.second }
    return entries
}

class ThreadsModel(private val app: WilsonApp) : ViewModel() {
    val threads = MutableStateFlow<List<ChatThread>?>(null)
    val error = MutableStateFlow<String?>(null)
    val opened = MutableSharedFlow<String>(extraBufferCapacity = 1)

    fun load() {
        viewModelScope.launch {
            try {
                threads.value = app.session.call { it.chat.listChatThreads() }.filter { it.archivedAt == null }
            } catch (failure: Exception) {
                error.value = reasonFor(failure)
            }
        }
    }

    fun start() {
        viewModelScope.launch {
            try {
                opened.emit(app.session.call { it.chat.startAChatThread() }.id)
            } catch (failure: Exception) {
                error.value = reasonFor(failure)
            }
        }
    }
}

data class ChatState(
    val thread: ChatThread? = null,
    val messages: List<ChatMessage> = emptyList(),
    val actions: List<ChatPendingAction> = emptyList(),
    val questions: List<ChatPendingQuestion> = emptyList(),
    /** The question whose answers are on their way, so its card cannot be submitted twice. */
    val answering: String? = null,
    val draft: String = "",
    val composer: String = "",
    val sent: String? = null,
    val sending: Boolean = false,
    val error: String? = null,
)

class ChatModel(private val app: WilsonApp, private val id: String) : ViewModel() {
    val state = MutableStateFlow(ChatState())

    /** One-off sentences for this screen's own snackbar. */
    val notices = MutableSharedFlow<String>(extraBufferCapacity = 4)

    /** This thread's images, held while the screen is. Decoding runs off the main thread. */
    private val images =
        ChatImages<ImageBitmap>(
            viewModelScope,
            fetch = { thread, attachment -> fetchChatImage(app.session, thread, attachment) },
            decode = { bytes -> withContext(Dispatchers.Default) { decodeImage(bytes) } },
        )

    fun image(attachmentId: String): StateFlow<ImageLoad<ImageBitmap>> = images.load(id, attachmentId)

    /**
     * Each question card's half-made answer, by question id. Held here rather than in the card so that rotating
     * the phone, which rebuilds the screen but not this model, does not lose it.
     */
    internal val questionDrafts = MutableStateFlow<Map<String, QuestionDraft>>(emptyMap())

    internal fun edit(questionId: String, draft: QuestionDraft) =
        questionDrafts.update { (it + (questionId to draft)).keptFor(state.value.questions, now()) }

    init {
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        try {
            val detail = app.session.call { it.chat.getAChatThread(id) }
            state.update { it.copy(thread = detail.thread, messages = detail.messages, actions = detail.actions, questions = detail.questions) }
            questionDrafts.update { it.keptFor(detail.questions, now()) }
        } catch (error: Exception) {
            state.update { it.copy(error = reasonFor(error)) }
        }
    }

    /**
     * A thread's turn in progress. Chat events are not replayed, so any reconnect re-reads the stored
     * thread: that is the record, and the stream is only what is still arriving.
     */
    suspend fun follow() {
        app.session.liveStream(HttpClients.stream, "/api/chat/threads/$id/stream", null).collect { signal ->
            when (signal) {
                StreamSignal.Live -> load()
                StreamSignal.Down -> state.update { it.copy(draft = "") }
                is StreamSignal.Event ->
                    when (signal.event.event) {
                        "delta" -> state.update { it.copy(draft = it.draft + signal.event.data) }
                        "proposed", "asked" -> load()
                        "done", "failed" -> {
                            state.update { it.copy(draft = "") }
                            load()
                        }
                    }
            }
        }
    }

    fun type(text: String) = state.update { it.copy(composer = text) }

    fun send(text: String = state.value.composer.trim()) {
        if (text.isEmpty()) return
        state.update { it.copy(sending = true, composer = "", sent = text, error = null) }
        viewModelScope.launch {
            try {
                val project = app.settings.project.first()
                app.session.call(patience = Patience.LONG) { it.chat.sendAChatMessage(id, SendChatMessageRequest(text, project)) }
                load()
                state.update { it.copy(sending = false, sent = null, draft = "") }
            } catch (error: Exception) {
                load()
                state.update { it.copy(sending = false, sent = null, composer = text, error = reasonFor(error)) }
            }
        }
    }

    fun decide(actionId: String, decision: DecideChatActionRequestDecision) {
        viewModelScope.launch {
            try {
                app.session.call(patience = Patience.LONG) { it.chat.decideAChatAction(actionId, DecideChatActionRequest(decision)) }
                load()
            } catch (error: Exception) {
                load()
                state.update { it.copy(error = reasonFor(error)) }
            }
        }
    }

    /**
     * Answers a question the chat asked, one answer per question in order. The thread is read again either
     * way, since that is the record; a refusal is said in the snackbar and the card stays answerable.
     */
    internal fun answer(questionId: String, answers: List<ChatQuestionAnswer>) {
        if (state.value.answering != null) return
        state.update { it.copy(answering = questionId) }
        viewModelScope.launch {
            try {
                app.session.call(patience = Patience.LONG) { it.chat.answerChatQuestions(id, questionId, AnswerChatQuestionsRequest(answers)) }
                load()
                state.update { it.copy(answering = null) }
            } catch (error: Exception) {
                load()
                state.update { it.copy(answering = null) }
                notices.emit(reasonFor(error))
            }
        }
    }

    internal fun now(): Instant = Clock.System.now()
}

/** The longest side an image is decoded at: enough to fill a phone's screen when opened, and no more. */
private const val LONGEST_SIDE = 2048

/** Null when the bytes are not something `BitmapFactory` reads, which an SVG is not. */
private fun decodeImage(bytes: ByteArray): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val options = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, LONGEST_SIDE) }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
}
