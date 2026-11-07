package com.maroonedsoftware.wilson.ui.goal

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.StreamSignal
import com.maroonedsoftware.wilson.auth.liveStream
import com.maroonedsoftware.wilson.board.ActivityTone
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.sdk.models.Goal
import com.maroonedsoftware.wilson.sdk.models.GoalDetail
import com.maroonedsoftware.wilson.sdk.models.GoalStatus
import com.maroonedsoftware.wilson.sdk.models.UpdateGoalRequest
import com.maroonedsoftware.wilson.sdk.models.UpdateGoalRequestStatus
import com.maroonedsoftware.wilson.ui.board.isToolEvent
import com.maroonedsoftware.wilson.ui.card.reasonFor
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val RELOAD_SETTLE_MS = 300L

/** Whether a goal is still being worked toward. The same rule as `isOpen` in the web app's `lib/goals.ts`. */
internal fun isOpen(status: GoalStatus): Boolean = status == GoalStatus.ACTIVE || status == GoalStatus.PAUSED

/**
 * A status as a person reads it: its wire spelling, and "unknown" for one this SDK does not know.
 * Never goes through the generated serializer, whose writer throws on [GoalStatus.UNKNOWN].
 */
internal fun statusWord(status: GoalStatus): String = status.name.lowercase()

/** A status's colour, from the app's own tones rather than web's `statusColor`. There is no yellow, so paused is a warning. */
internal fun goalTone(status: GoalStatus): ActivityTone =
    when (status) {
        GoalStatus.ACTIVE -> ActivityTone.GOOD
        GoalStatus.PAUSED -> ActivityTone.WARNING
        GoalStatus.DONE -> ActivityTone.INFO
        GoalStatus.ABANDONED -> ActivityTone.QUIET
        GoalStatus.UNKNOWN -> ActivityTone.QUIET
    }

/** Open goals, then finished ones, each in the server's own order, as `goals.index.tsx` filters them. */
internal fun partitionGoals(goals: List<Goal>): Pair<List<Goal>, List<Goal>> = goals.partition { isOpen(it.status) }

/** One status button: the status it moves the goal to, its label, and what the snackbar says once it has. */
data class GoalAction(val to: UpdateGoalRequestStatus, val label: String, val done: String)

private val PAUSE = GoalAction(UpdateGoalRequestStatus.PAUSED, "Pause", "Paused.")
private val RESUME = GoalAction(UpdateGoalRequestStatus.ACTIVE, "Resume", "Resumed.")
private val MARK_DONE = GoalAction(UpdateGoalRequestStatus.DONE, "Mark done", "Marked done.")
private val ABANDON = GoalAction(UpdateGoalRequestStatus.ABANDONED, "Abandon", "Abandoned.")
private val REOPEN = GoalAction(UpdateGoalRequestStatus.ACTIVE, "Reopen", "Reopened.")

/**
 * What a person can do with a goal in each status, kept in step with `STATUS_ACTIONS` in
 * `goals.$goalId.tsx`. A status this SDK does not know offers nothing, since nothing about it is known.
 */
internal fun goalActions(status: GoalStatus): List<GoalAction> =
    when (status) {
        GoalStatus.ACTIVE -> listOf(PAUSE, MARK_DONE, ABANDON)
        GoalStatus.PAUSED -> listOf(RESUME, MARK_DONE, ABANDON)
        GoalStatus.DONE, GoalStatus.ABANDONED -> listOf(REOPEN)
        GoalStatus.UNKNOWN -> emptyList()
    }

data class GoalsState(val goals: List<Goal>? = null, val refreshing: Boolean = false, val error: String? = null)

/** Every goal, from every project, as web lists them. The screen reads it on each resume and on a pull. */
class GoalsModel(private val app: WilsonApp) : ViewModel() {
    val state = MutableStateFlow(GoalsState())

    fun refresh() {
        state.update { it.copy(refreshing = true) }
        viewModelScope.launch {
            try {
                val goals = app.session.call { it.goals.listGoals() }
                state.update { it.copy(goals = goals, refreshing = false, error = null) }
            } catch (error: Exception) {
                state.update { it.copy(refreshing = false, error = reasonFor(error)) }
            }
        }
    }
}

data class GoalState(val detail: GoalDetail? = null, val acting: Boolean = false, val error: String? = null)

class GoalModel(private val app: WilsonApp, private val id: String) : ViewModel() {
    val state = MutableStateFlow(GoalState())

    /** One-off sentences for this screen's own snackbar. */
    val notices = MutableSharedFlow<String>(extraBufferCapacity = 4)

    suspend fun reload() {
        try {
            val detail = app.session.call { it.goals.getAGoal(id) }
            state.update { it.copy(detail = detail, error = null) }
        } catch (error: Exception) {
            state.update { it.copy(error = reasonFor(error)) }
        }
    }

    /** Says [GoalAction.done], or the server's refusal. Neither writes a status: only a re-read does. */
    fun change(action: GoalAction) {
        state.update { it.copy(acting = true) }
        viewModelScope.launch {
            val note =
                try {
                    app.session.call { it.goals.updateAGoal(id, UpdateGoalRequest(status = action.to)) }
                    action.done
                } catch (error: Exception) {
                    reasonFor(error)
                }
            reload()
            state.update { it.copy(acting = false) }
            notices.emit(note)
        }
    }

    /**
     * Re-reads the goal on each feed event of its project that is not a `tool.*` call, for as long as the
     * screen is started. Any card in the project may be one of the goal's, so no card filter.
     */
    suspend fun follow() {
        val project = state.mapNotNull { it.detail?.goal?.project }.first()
        app.session.liveStream(HttpClients.stream, "/api/feed", project)
            .filter { signal -> signal is StreamSignal.Event && !isToolEvent(signal.event.data) }
            .collectLatest {
                delay(RELOAD_SETTLE_MS)
                reload()
            }
    }
}
