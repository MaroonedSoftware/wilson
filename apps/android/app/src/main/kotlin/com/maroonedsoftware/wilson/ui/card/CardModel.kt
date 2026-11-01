package com.maroonedsoftware.wilson.ui.card

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.StreamSignal
import com.maroonedsoftware.wilson.auth.liveStream
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.net.Patience
import com.maroonedsoftware.wilson.sdk.WilsonSdk
import com.maroonedsoftware.wilson.sdk.models.CardDetail
import com.maroonedsoftware.wilson.sdk.models.CardDiff
import com.maroonedsoftware.wilson.sdk.models.CardEvent
import com.maroonedsoftware.wilson.sdk.models.CardUsage
import com.maroonedsoftware.wilson.sdk.models.ListQuery
import com.maroonedsoftware.wilson.sdk.models.MoveCardRequest
import com.maroonedsoftware.wilson.sdk.runtime.SdkError
import java.io.IOException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
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
    val stages: List<String> = emptyList(),
    val acting: String? = null,
)

/** What a merge came to. Pure, because getting "unknown" right is the point of it. */
sealed interface MergeOutcome {
    data class Landed(val commit: String?) : MergeOutcome

    data class Refused(val reason: String) : MergeOutcome

    /** The answer never arrived, which says nothing about whether the merge happened. Never retried. */
    data object Unknown : MergeOutcome
}

internal fun mergeMessage(outcome: MergeOutcome): String =
    when (outcome) {
        is MergeOutcome.Landed -> "Landed on main${outcome.commit?.let { " as ${it.take(8)}" } ?: ""}."
        is MergeOutcome.Refused -> outcome.reason
        MergeOutcome.Unknown -> "The merge's answer was lost, so it may still have landed. Check the card before trying again."
    }

class CardModel(private val app: WilsonApp, private val project: String, private val id: String) : ViewModel() {
    val state = MutableStateFlow(CardState())

    /** One-off sentences for this screen's own snackbar. */
    val notices = MutableSharedFlow<String>(extraBufferCapacity = 4)

    init {
        viewModelScope.launch { load() }
        viewModelScope.launch {
            runCatching { app.session.call(project) { it.board.listBoardColumns() } }.onSuccess { columns ->
                state.update { it.copy(stages = columns.stages + columns.nonStages) }
            }
        }
    }

    suspend fun reload() = load()

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

    /** Says [done], or the server's refusal, on the screen that asked. Neither writes a stage: only a re-read does. */
    private fun act(label: String, done: String, block: suspend (WilsonSdk) -> Unit) {
        state.update { it.copy(acting = label) }
        viewModelScope.launch {
            val note =
                try {
                    app.session.call(project) { block(it) }
                    done
                } catch (error: Exception) {
                    reasonFor(error)
                }
            load()
            state.update { it.copy(acting = null) }
            notices.emit(note)
        }
    }

    fun acknowledge() = act("ack", "Acknowledged.") { it.board.acknowledgeAFlaggedCard(id) }

    fun approve() = act("approve", "Plan approved.") { it.board.approveCardPlan(id) }

    fun start() = act("start", "Queued for its stage.") { it.board.startCard(id) }

    fun release() = act("release", "Released.") { it.board.releaseCard(id) }

    fun move(stage: String) = act("move", "Moved to $stage.") { it.board.moveCard(id, MoveCardRequest(stage)) }

    /**
     * A merge runs the suite first, so it gets the long client, and only a server's answer is an
     * answer: a dropped connection is [MergeOutcome.Unknown], and the card is re-read, never retried.
     */
    fun merge() {
        state.update { it.copy(acting = "merge") }
        viewModelScope.launch {
            val outcome =
                try {
                    val result = app.session.call(project, Patience.LONG) { it.board.mergeCard(id) }
                    if (result.merged) MergeOutcome.Landed(result.commit) else MergeOutcome.Refused(result.reason ?: "The merge did not land.")
                } catch (error: SdkError) {
                    MergeOutcome.Refused(reasonFor(error))
                } catch (error: IOException) {
                    MergeOutcome.Unknown
                }
            load()
            state.update { it.copy(acting = null) }
            notices.emit(mergeMessage(outcome))
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
