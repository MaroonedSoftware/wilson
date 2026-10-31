package com.maroonedsoftware.wilson.ui.plan

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.StreamSignal
import com.maroonedsoftware.wilson.auth.liveStream
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.net.Patience
import com.maroonedsoftware.wilson.sdk.models.CreatePlanCommentRequest
import com.maroonedsoftware.wilson.sdk.models.PlanComment
import com.maroonedsoftware.wilson.sdk.models.PlanTurn
import com.maroonedsoftware.wilson.sdk.models.PlanTurnRequest
import com.maroonedsoftware.wilson.sdk.models.PlanTurnRequestMode
import com.maroonedsoftware.wilson.sdk.models.PlanTurnRole
import com.maroonedsoftware.wilson.sdk.models.SaveDraftRequest
import com.maroonedsoftware.wilson.sdk.runtime.SdkJson
import com.maroonedsoftware.wilson.ui.card.reasonFor
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class PlanState(
    val open: Boolean = false,
    val turns: List<PlanTurn> = emptyList(),
    val pending: String = "",
    val composer: String = "",
    /** The message on its way, shown until the turn it became arrives. */
    val sent: String? = null,
    val draft: String = "",
    val savedDraft: String = "",
    val comments: List<PlanComment> = emptyList(),
    val sending: Boolean = false,
    val live: Boolean = false,
    val error: String? = null,
)

/** Folds [turn] in by `seq`: a turn arrives from the stream and from the POST, and must show once. */
internal fun insertBySeq(turns: List<PlanTurn>, turn: PlanTurn): List<PlanTurn> = (turns.filter { it.seq != turn.seq } + turn).sortedBy { it.seq }

/**
 * Folds in a reply, with the message that asked for it. The stream replays stored turns only on
 * connecting and the POST answers with the reply alone, so nothing else delivers the person's own
 * turn while the screen stays open. It stored just before the reply, and a later replay of the real
 * one lands on the same `seq` and replaces this.
 */
internal fun withReply(turns: List<PlanTurn>, reply: PlanTurn, sent: String): List<PlanTurn> {
    val asked = PlanTurn(seq = reply.seq - 1, role = PlanTurnRole.USER, content = sent, createdAt = reply.createdAt)
    return insertBySeq(if (sent.isBlank() || turns.any { it.seq == asked.seq }) turns else insertBySeq(turns, asked), reply)
}

/** What one stream event does to the transcript. Pure, so a resume can be replayed in a test. */
internal fun applySignal(state: PlanState, event: String, data: String): PlanState =
    when (event) {
        "turn" -> state.copy(turns = insertBySeq(state.turns, SdkJson.decodeFromString<PlanTurn>(data)), pending = "")
        "delta" -> state.copy(pending = state.pending + data)
        else -> state
    }

class PlanModel(private val app: WilsonApp, private val project: String, private val id: String) : ViewModel() {
    val state = MutableStateFlow(PlanState())
    val notices = MutableSharedFlow<String>(extraBufferCapacity = 4)

    /** Fires once the draft has been approved or the session closed, and the screen should leave. */
    val finished = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    init {
        viewModelScope.launch {
            try {
                app.session.call(project) { it.board.openAPlanningSession(id) }
                val draft = app.session.call(project) { it.board.getAPlanDraft(id) }.body
                val comments = app.session.call(project) { it.board.listPlanComments(id) }
                state.update { it.copy(open = true, draft = draft, savedDraft = draft, comments = comments) }
            } catch (error: Exception) {
                state.update { it.copy(error = reasonFor(error)) }
            }
        }
    }

    /**
     * The transcript, for as long as the screen is started. A replay is everything after the last
     * turn held, so coming back from the background misses nothing. A delta has no id, so a drop
     * mid-reply clears the partial text and the finished turn replaces it.
     */
    suspend fun follow() {
        val after = state.value.turns.lastOrNull()?.seq?.toString()
        app.session.liveStream(HttpClients.stream, "/api/cards/$id/plan/stream", project, resumeFrom = after).collect { signal ->
            when (signal) {
                StreamSignal.Live -> state.update { it.copy(live = true) }
                StreamSignal.Down -> state.update { it.copy(live = false, pending = "") }
                is StreamSignal.Event -> state.update { current -> applySignal(current, signal.event.event, signal.event.data) }
            }
        }
    }

    fun type(text: String) = state.update { it.copy(composer = text) }

    fun editDraft(text: String) = state.update { it.copy(draft = text) }

    /** Waits for the agent, so it takes the long client. The reply's text streams in the meantime. */
    fun send(mode: PlanTurnRequestMode? = null) {
        val text = state.value.composer.trim()
        if (text.isEmpty() && mode == null) return
        state.update { it.copy(sending = true, composer = "", sent = text, error = null) }
        viewModelScope.launch {
            try {
                val reply = app.session.call(project, Patience.LONG) { it.board.sendAPlanTurn(id, PlanTurnRequest(text, mode)) }
                val draft = runCatching { app.session.call(project) { it.board.getAPlanDraft(id) }.body }.getOrNull()
                state.update { current ->
                    // The agent writes the draft, so a fresh one replaces the local copy unless it has unsaved edits.
                    val untouched = current.draft == current.savedDraft
                    current.copy(
                        turns = withReply(current.turns, reply, text),
                        pending = "",
                        sent = null,
                        sending = false,
                        draft = if (draft != null && untouched) draft else current.draft,
                        savedDraft = draft ?: current.savedDraft,
                    )
                }
            } catch (error: Exception) {
                state.update { it.copy(sending = false, sent = null, composer = text, error = reasonFor(error)) }
            }
        }
    }

    fun approve() {
        val body = state.value.draft
        viewModelScope.launch {
            try {
                app.session.call(project) { it.board.saveAPlanDraft(id, SaveDraftRequest(body)) }
                notices.emit("Saved as a new version of the plan.")
                state.update { it.copy(savedDraft = body) }
            } catch (error: Exception) {
                notices.emit(reasonFor(error))
            }
        }
    }

    fun close() {
        viewModelScope.launch {
            try {
                app.session.call(project) { it.board.closeAPlanningSession(id) }
                finished.emit(Unit)
            } catch (error: Exception) {
                notices.emit(reasonFor(error))
            }
        }
    }

    /** The server anchors a comment by its quote, so a quote that appears twice may be refused in its own words. */
    fun comment(quote: String, text: String) {
        viewModelScope.launch {
            try {
                val added = app.session.call(project) { it.board.addAPlanComment(id, CreatePlanCommentRequest(quote, "", "", text)) }
                state.update { it.copy(comments = it.comments + added) }
            } catch (error: Exception) {
                notices.emit(reasonFor(error))
            }
        }
    }

    fun resolve(commentId: String) {
        viewModelScope.launch {
            try {
                val resolved = app.session.call(project) { it.board.resolveAPlanComment(id, commentId) }
                state.update { current -> current.copy(comments = current.comments.map { if (it.id == commentId) resolved else it }) }
            } catch (error: Exception) {
                notices.emit(reasonFor(error))
            }
        }
    }
}
