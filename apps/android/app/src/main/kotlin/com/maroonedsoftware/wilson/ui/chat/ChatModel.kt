package com.maroonedsoftware.wilson.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.StreamSignal
import com.maroonedsoftware.wilson.auth.liveStream
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.net.Patience
import com.maroonedsoftware.wilson.sdk.models.ChatMessage
import com.maroonedsoftware.wilson.sdk.models.ChatPendingAction
import com.maroonedsoftware.wilson.sdk.models.ChatPendingActionStatus
import com.maroonedsoftware.wilson.sdk.models.ChatThread
import com.maroonedsoftware.wilson.sdk.models.DecideChatActionRequest
import com.maroonedsoftware.wilson.sdk.models.DecideChatActionRequestDecision
import com.maroonedsoftware.wilson.sdk.models.SendChatMessageRequest
import com.maroonedsoftware.wilson.ui.card.reasonFor
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

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
    val draft: String = "",
    val composer: String = "",
    val sent: String? = null,
    val sending: Boolean = false,
    val error: String? = null,
)

class ChatModel(private val app: WilsonApp, private val id: String) : ViewModel() {
    val state = MutableStateFlow(ChatState())

    init {
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        try {
            val detail = app.session.call { it.chat.getAChatThread(id) }
            state.update { it.copy(thread = detail.thread, messages = detail.messages, actions = detail.actions) }
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
                        "proposed" -> load()
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

    internal fun now(): Instant = Clock.System.now()
}
