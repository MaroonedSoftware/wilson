package com.maroonedsoftware.wilson.ui.board

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.StreamSignal
import com.maroonedsoftware.wilson.auth.liveStream
import com.maroonedsoftware.wilson.board.columnOrder
import com.maroonedsoftware.wilson.board.groupByStage
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.sdk.models.CardSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class BoardState(
    val projects: List<String> = emptyList(),
    val project: String? = null,
    val columns: List<String> = emptyList(),
    val cards: Map<String, List<CardSummary>> = emptyMap(),
    val flaggedOnly: Boolean = false,
    val refreshing: Boolean = false,
    val loaded: Boolean = false,
    val live: Boolean = false,
    val error: String? = null,
) {
    val flagged: List<CardSummary> get() = cards.values.flatten().filter { it.needsHuman }
}

class BoardModel(private val app: WilsonApp) : ViewModel() {
    val state = MutableStateFlow(BoardState())

    init {
        viewModelScope.launch {
            try {
                val projects = app.session.call { it.projects.listProjects() }.map { it.name }
                val kept = app.settings.project.first()
                state.update { it.copy(projects = projects, project = kept?.takeIf { name -> name in projects } ?: projects.firstOrNull()) }
                refresh()
            } catch (error: Exception) {
                state.update { it.copy(error = "Could not load projects: ${error.message}", loaded = true) }
            }
        }
    }

    fun refresh() {
        val project = state.value.project ?: return state.update { it.copy(loaded = true) }
        state.update { it.copy(refreshing = true) }
        viewModelScope.launch { load(project) }
    }

    private suspend fun load(project: String) {
        try {
            val (columns, cards) = app.session.call(project) { it.board.listBoardColumns() to it.board.listCards() }
            state.update {
                if (it.project != project) it
                else it.copy(columns = columnOrder(columns, cards), cards = groupByStage(cards), refreshing = false, loaded = true, error = null)
            }
        } catch (error: Exception) {
            state.update { it.copy(refreshing = false, loaded = true, error = "Could not load the board: ${error.message}") }
        }
    }

    /**
     * Follows the card feed for as long as the screen is started. Each burst of events becomes one
     * reload, since connecting replays a snapshot of every card. `tool.*` events change nothing the
     * board shows, as the web feed also knows, so they do not reload it. A reconnect always reloads:
     * the feed does not replay what happened during the drop.
     */
    suspend fun follow(project: String) {
        app.session.liveStream(HttpClients.stream, "/api/feed", project)
            .onEach { signal -> if (signal !is StreamSignal.Event) state.update { it.copy(live = signal == StreamSignal.Live) } }
            .mapNotNull { signal ->
                when (signal) {
                    StreamSignal.Live -> Unit
                    StreamSignal.Down -> null
                    is StreamSignal.Event -> Unit.takeIf { !isToolEvent(signal.event.data) }
                }
            }
            .collectLatest {
                delay(RELOAD_SETTLE_MS)
                load(project)
            }
    }

    fun selectProject(name: String) {
        state.update { it.copy(project = name, columns = emptyList(), cards = emptyMap(), loaded = false) }
        viewModelScope.launch { app.settings.saveProject(name) }
        refresh()
    }

    fun toggleFlagged() = state.update { it.copy(flaggedOnly = !it.flaggedOnly) }

    fun signOut() {
        viewModelScope.launch { app.push.signOut() }
    }

    private companion object {
        const val RELOAD_SETTLE_MS = 300L
    }
}

/** A feed event's type is its `message` (`card.feed.listener.ts`). Anything unreadable reloads, which is safe. */
internal fun isToolEvent(data: String): Boolean =
    runCatching { Json.parseToJsonElement(data).jsonObject["message"]?.jsonPrimitive?.contentOrNull?.startsWith("tool.") == true }.getOrDefault(false)
