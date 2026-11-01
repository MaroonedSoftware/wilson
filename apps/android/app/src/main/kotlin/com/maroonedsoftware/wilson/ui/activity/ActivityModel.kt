package com.maroonedsoftware.wilson.ui.activity

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.StreamSignal
import com.maroonedsoftware.wilson.auth.liveStream
import com.maroonedsoftware.wilson.board.leavesGap
import com.maroonedsoftware.wilson.board.mergeNewest
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.sdk.models.ActivityEvent
import com.maroonedsoftware.wilson.sdk.models.ActivityQuery
import com.maroonedsoftware.wilson.ui.board.isToolEvent
import com.maroonedsoftware.wilson.ui.card.reasonFor
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ActivityState(
    val events: List<ActivityEvent> = emptyList(),
    val loaded: Boolean = false,
    val refreshing: Boolean = false,
    val loadingOlder: Boolean = false,
    val hasOlder: Boolean = false,
    val error: String? = null,
)

class ActivityModel(private val app: WilsonApp, private val project: String) : ViewModel() {
    val state = MutableStateFlow(ActivityState())

    fun refresh() {
        state.update { it.copy(refreshing = true) }
        viewModelScope.launch { loadNewest() }
    }

    private suspend fun loadNewest() {
        try {
            val page = app.session.call(project) { it.board.listProjectActivity(ActivityQuery(limit = PAGE_SIZE)) }
            state.update {
                val gap = leavesGap(it.events, page, PAGE_SIZE)
                it.copy(
                    events = if (gap) page else mergeNewest(it.events, page),
                    // Only a fresh start: otherwise the newest page says nothing about how far back has been read.
                    hasOlder = if (it.loaded && !gap) it.hasOlder else page.size >= PAGE_SIZE,
                    loaded = true,
                    refreshing = false,
                    error = null,
                )
            }
        } catch (error: Exception) {
            state.update { it.copy(loaded = true, refreshing = false, error = reasonFor(error)) }
        }
    }

    fun loadOlder() {
        val before = state.value.events.lastOrNull()?.id?.toLongOrNull() ?: return
        if (state.value.loadingOlder) return
        state.update { it.copy(loadingOlder = true) }
        viewModelScope.launch {
            try {
                val page = app.session.call(project) { it.board.listProjectActivity(ActivityQuery(limit = PAGE_SIZE, before = before)) }
                state.update { it.copy(events = it.events + page, hasOlder = page.size >= PAGE_SIZE, loadingOlder = false, error = null) }
            } catch (error: Exception) {
                state.update { it.copy(loadingOlder = false, error = reasonFor(error)) }
            }
        }
    }

    /** Re-reads the newest page on each feed event, which `tool.*` calls are not: this page leaves them out. */
    suspend fun follow() {
        app.session.liveStream(HttpClients.stream, "/api/feed", project)
            .filter { signal -> signal is StreamSignal.Event && !isToolEvent(signal.event.data) }
            .collectLatest {
                delay(RELOAD_SETTLE_MS)
                loadNewest()
            }
    }

    private companion object {
        const val PAGE_SIZE = 50L
        const val RELOAD_SETTLE_MS = 300L
    }
}
