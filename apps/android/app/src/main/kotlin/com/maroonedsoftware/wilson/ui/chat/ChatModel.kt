package com.maroonedsoftware.wilson.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.StreamSignal
import com.maroonedsoftware.wilson.auth.liveStream
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.net.Patience
import com.maroonedsoftware.wilson.sdk.models.ChatMessage
import com.maroonedsoftware.wilson.sdk.models.ChatMessageRole
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

/** What a message says about the images it carries, since only the desktop app draws them. Null when it carries none. */
internal fun imagesCaption(count: Int): String? = when (count) {
    0 -> null
    1 -> "1 image"
    else -> "$count images"
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

/** One thing in a conversation, in the order [timeline] puts them. */
internal sealed interface ChatEntry {
    val key: String

    data class Said(val message: ChatMessage) : ChatEntry {
        override val key get() = "m${message.seq}"
    }

    data class Proposal(val action: ChatPendingAction) : ChatEntry {
        override val key get() = "a${action.id}"
    }
}

/**
 * Messages and actions in the order they happened, except that an action follows the answer of the turn
 * that proposed it. It is stored while the turn runs and the answer only at the end, so by time alone it
 * would sit above that answer, off a phone's screen, and move when the answer arrived. Here it stays last,
 * and a decided card does not jump away from the Confirm just pressed. The web app sorts by time alone.
 */
internal fun timeline(messages: List<ChatMessage>, actions: List<ChatPendingAction>): List<ChatEntry> {
    val waiting = ArrayDeque(actions.sortedBy { it.createdAt })
    val entries = mutableListOf<ChatEntry>()
    fun takeActionsUpTo(at: Instant) {
        while (waiting.firstOrNull()?.let { it.createdAt <= at } == true) entries += ChatEntry.Proposal(waiting.removeFirst())
    }
    messages.forEach { message ->
        if (message.role == ChatMessageRole.USER) takeActionsUpTo(message.createdAt)
        entries += ChatEntry.Said(message)
        if (message.role != ChatMessageRole.USER) takeActionsUpTo(message.createdAt)
    }
    waiting.mapTo(entries) { ChatEntry.Proposal(it) }
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
