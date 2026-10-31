package com.maroonedsoftware.wilson.ui.card

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.StreamSignal
import com.maroonedsoftware.wilson.auth.liveStream
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.sdk.models.CardDetail
import com.maroonedsoftware.wilson.sdk.models.CardDiff
import com.maroonedsoftware.wilson.sdk.models.CardEvent
import com.maroonedsoftware.wilson.sdk.models.CardUsage
import com.maroonedsoftware.wilson.sdk.models.ListQuery
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class CardState(
    val card: CardDetail? = null,
    val events: List<CardEvent> = emptyList(),
    val usage: CardUsage? = null,
    val diff: CardDiff? = null,
    val diffError: String? = null,
    val error: String? = null,
)

class CardModel(private val app: WilsonApp, private val project: String, private val id: String) : ViewModel() {
    val state = MutableStateFlow(CardState())

    init {
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        try {
            val card = app.session.call(project) { it.board.getCard(id) }
            val events = app.session.call(project) { it.board.listCardEvents(id, ListQuery(limit = EVENT_LIMIT)) }
            val usage = runCatching { app.session.call(project) { it.board.getCardUsage(id) } }.getOrNull()
            state.update { it.copy(card = card, events = events, usage = usage, error = null) }
        } catch (error: Exception) {
            state.update { it.copy(error = reasonFor(error)) }
        }
    }

    fun loadDiff() {
        viewModelScope.launch {
            try {
                val diff = app.session.call(project) { it.board.getCardDiff(id) }
                state.update { it.copy(diff = diff, diffError = null) }
            } catch (error: Exception) {
                state.update { it.copy(diffError = reasonFor(error)) }
            }
        }
    }

    /** Re-reads the card whenever the feed mentions it, for as long as the screen is started. */
    suspend fun follow() {
        app.session.liveStream(HttpClients.stream, "/api/feed", project)
            .filter { it is StreamSignal.Event && feedCardId(it.event.data) == id }
            .collectLatest {
                delay(RELOAD_SETTLE_MS)
                load()
            }
    }

    private companion object {
        const val EVENT_LIMIT = 100L
        const val RELOAD_SETTLE_MS = 300L
    }
}

/** A feed event's card is its `correlationId` (`card.feed.listener.ts`). */
internal fun feedCardId(data: String): String? =
    runCatching { Json.parseToJsonElement(data).jsonObject["correlationId"]?.jsonPrimitive?.contentOrNull }.getOrNull()
