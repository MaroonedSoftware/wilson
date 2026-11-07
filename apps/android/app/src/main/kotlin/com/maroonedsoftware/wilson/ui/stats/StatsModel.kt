package com.maroonedsoftware.wilson.ui.stats

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.StreamSignal
import com.maroonedsoftware.wilson.auth.liveStream
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.ui.board.isToolEvent
import com.maroonedsoftware.wilson.ui.card.reasonFor
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class StatsModel(private val app: WilsonApp, private val project: String) : ViewModel() {
    val state = MutableStateFlow(StatsState())
    private var reading: Job? = null

    /** Shows [days], re-reading both reads together. The figures on screen stay until the new ones arrive. */
    fun select(days: Long) {
        state.update { it.choosing(days) }
        read()
    }

    fun refresh() = select(state.value.days)

    private fun read() {
        val days = state.value.days
        // Only the newest choice's read matters; `loaded` would drop an older one anyway.
        reading?.cancel()
        reading = viewModelScope.launch {
            try {
                val figures = app.session.call(project) { sdk ->
                    readStats(days, { sdk.board.getProjectStats(it) }, { sdk.board.getProjectGateStats(it) })
                }
                state.update { it.loaded(figures) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                state.update { it.failed(days, reasonFor(error)) }
            }
        }
    }

    /** Re-reads on each feed event, as web invalidates its stats query on each, leaving out `tool.*` calls. */
    suspend fun follow() {
        app.session.liveStream(HttpClients.stream, "/api/feed", project)
            .filter { signal -> signal is StreamSignal.Event && !isToolEvent(signal.event.data) }
            .collectLatest {
                delay(RELOAD_SETTLE_MS)
                refresh()
            }
    }

    private companion object {
        // Longer than the activity page's: both reads sum the whole window on each request.
        const val RELOAD_SETTLE_MS = 1_000L
    }
}
