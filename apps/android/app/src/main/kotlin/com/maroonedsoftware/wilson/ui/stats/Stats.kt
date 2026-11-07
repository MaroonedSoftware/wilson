package com.maroonedsoftware.wilson.ui.stats

import com.maroonedsoftware.wilson.sdk.models.ProjectConversationStatsKind
import com.maroonedsoftware.wilson.sdk.models.ProjectGateFailureFailureClass
import com.maroonedsoftware.wilson.sdk.models.ProjectGateKickback
import com.maroonedsoftware.wilson.sdk.models.ProjectGateKickbackReason
import com.maroonedsoftware.wilson.sdk.models.ProjectGateRevised
import com.maroonedsoftware.wilson.sdk.models.ProjectGateStats
import com.maroonedsoftware.wilson.sdk.models.ProjectGateTouchpointCause
import com.maroonedsoftware.wilson.sdk.models.ProjectStageStats
import com.maroonedsoftware.wilson.sdk.models.ProjectStats
import com.maroonedsoftware.wilson.sdk.models.ProjectStatsQuery
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToLong
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/*
 * What the stats screen shows, as web's `ProjectStats.tsx` draws it. A phone shows all of it, as cards and
 * short rows rather than wide tables:
 * - four headline tiles: output tokens, input tokens and how much was cached, attempts passed, cards;
 * - the gates: first pass, kickbacks, people pulled in with questions asked and answered, loop stops, and
 *   the kickback, failure, touchpoint and rule breakdowns, with the note on matched older events;
 * - output tokens per day, as a chart or a list;
 * - by stage, planning and review, and the cards that wrote the most.
 */

/** The windows web offers, in days. */
val STATS_WINDOWS = listOf(7L, 30L, 90L)

/** Web's default window. */
const val DEFAULT_WINDOW = 30L

/** Both reads for one window, kept together because the pass rate subtracts the gates' revises. */
data class StatsFigures(val days: Long, val stats: ProjectStats, val gates: ProjectGateStats)

/**
 * `days` is the window chosen, and `figures` what is on screen, which may still be an earlier window's
 * while `loading`: a new window keeps the previous figures up until its own arrive, as web's
 * `keepPreviousData` does.
 */
data class StatsState(
    val days: Long = DEFAULT_WINDOW,
    val figures: StatsFigures? = null,
    val loading: Boolean = true,
    val error: String? = null,
)

/** A window was chosen or re-read: the figures stay until the new ones arrive. */
fun StatsState.choosing(days: Long): StatsState = copy(days = days, loading = true)

/** A read finished. One for a window no longer chosen is dropped, so a slow read cannot overwrite a newer choice. */
fun StatsState.loaded(figures: StatsFigures): StatsState =
    if (figures.days != days) this else copy(figures = figures, loading = false, error = null)

/** A read failed, in the API's own words. The figures already on screen stay. */
fun StatsState.failed(days: Long, reason: String): StatsState = if (days != this.days) this else copy(loading = false, error = reason)

/** Both reads for [days] at once, as web's `Promise.all`: either failing fails the whole. */
suspend fun readStats(
    days: Long,
    stats: suspend (ProjectStatsQuery) -> ProjectStats,
    gates: suspend (ProjectStatsQuery) -> ProjectGateStats,
): StatsFigures = coroutineScope {
    val query = ProjectStatsQuery(days = days)
    val figures = async { stats(query) }
    val gateFigures = async { gates(query) }
    StatsFigures(days, figures.await(), gateFigures.await())
}

/** `part` of `whole` as a whole percentage, or null when there is no `whole` to be a share of. */
fun percentOf(part: Long, whole: Long): Long? = if (whole == 0L) null else (part.toDouble() / whole * 100).roundToLong()

fun percent(value: Long?): String = if (value == null) "–" else "$value%"

/**
 * Attempts that moved a card forward. A `revise` passed in `ProjectStats`' sense, as a well-formed review,
 * but it sends the card back. The floor is for a window the two requests read a moment apart.
 */
fun passedOutright(passed: Long, revised: Long): Long = maxOf(0L, passed - revised)

/** How many times `stage` asked for changes, or every stage when it is left out. */
fun revisedCount(revised: List<ProjectGateRevised>, stage: String? = null): Long =
    revised.filter { stage == null || it.stage == stage }.sumOf { it.count }

/** A stage's pass rate as web's "Passed" column: its revises are not a pass. */
fun stagePassRate(stage: ProjectStageStats, revised: List<ProjectGateRevised>): Long? =
    percentOf(passedOutright(stage.passed, revisedCount(revised, stage.stage)), stage.attempts)

/** Attempts per card to one decimal, or a dash with no cards. */
fun perCard(attempts: Long, cards: Long): String = if (cards == 0L) "–" else String.format(Locale.US, "%.1f", attempts.toDouble() / cards)

/** 1234567 as `1,234,567`. */
fun whole(value: Long): String = String.format(Locale.US, "%,d", value)

private val COMPACT_UNITS = listOf("" to 1.0, "K" to 1e3, "M" to 1e6, "B" to 1e9, "T" to 1e12)

/** 1,234,567 as `1.2M`, for a tile or an axis, as web's `compactTokens`. */
fun compactTokens(tokens: Long): String {
    val size = kotlin.math.abs(tokens.toDouble())
    var index = COMPACT_UNITS.indexOfLast { size >= it.second }.coerceAtLeast(0)
    var scaled = (tokens / COMPACT_UNITS[index].second * 10).roundToLong() / 10.0
    // 999,999 rounds to 1000K, which reads as 1M.
    if (kotlin.math.abs(scaled) >= 1000 && index < COMPACT_UNITS.lastIndex) {
        index += 1
        scaled = (tokens / COMPACT_UNITS[index].second * 10).roundToLong() / 10.0
    }
    val number = if (scaled == floor(scaled)) scaled.toLong().toString() else scaled.toString()
    return number + COMPACT_UNITS[index].first
}

/** The top of a chart's axis: the first of 1, 2, 2.5 or 5 times a power of ten at or above `max`. */
fun axisTop(max: Long): Double {
    if (max <= 0) return 1.0
    val power = 10.0.pow(floor(log10(max.toDouble())))
    return (listOf(1.0, 2.0, 2.5, 5.0, 10.0).firstOrNull { it * power >= max } ?: 10.0) * power
}

private val DAY = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)

/** `2026-11-07` as `7 Nov`, or the text as it came when it is not a date. */
fun dayLabel(date: String): String = runCatching { LocalDate.parse(date).format(DAY) }.getOrDefault(date)

/** One figure on a tile: a label, the figure, and what it is made of. */
data class Tile(val label: String, val value: String, val detail: String? = null)

/** Whether anything ran in the window, either a stage or a conversation. */
fun hasRun(stats: ProjectStats): Boolean =
    stats.total.attempts > 0 || stats.total.interrupted > 0 || stats.conversations.any { it.turns > 0 }

fun hasConversations(stats: ProjectStats): Boolean = stats.conversations.any { it.turns > 0 }

/** The four tiles at the top of web's page. */
fun headlineTiles(stats: ProjectStats, gates: ProjectGateStats): List<Tile> {
    val total = stats.total
    val conversationOutput = stats.conversations.sumOf { it.outputTokens }
    val revised = revisedCount(gates.revised)
    val passed = passedOutright(total.passed, revised)
    return listOf(
        Tile(
            "Output tokens",
            compactTokens(total.outputTokens),
            if (conversationOutput > 0) "plus ${compactTokens(conversationOutput)} in planning and review" else null,
        ),
        Tile("Input tokens", compactTokens(total.inputTokens), "${percent(percentOf(total.cachedInputTokens, total.inputTokens))} cached"),
        Tile(
            "Attempts passed",
            percent(percentOf(passed, total.attempts)),
            "$passed of ${total.attempts} attempts" + if (revised > 0) ", $revised asked for changes" else "",
        ),
        Tile(
            "Cards",
            whole(total.cards),
            if (total.cards > 0) "${perCard(total.attempts, total.cards)} attempts each, ${total.interrupted} interrupted" else null,
        ),
    )
}

/** The four tiles of web's gates panel. */
fun gateTiles(gates: ProjectGateStats): List<Tile> {
    val (upheld, overturned) = gates.challenge
    val asked = gates.questions.asked
    return listOf(
        Tile(
            "First pass",
            percent(percentOf(gates.firstPass.firstPass, gates.firstPass.reached)),
            "${gates.firstPass.firstPass} of ${gates.firstPass.reached} cards reaching ready, no retries spent",
        ),
        Tile(
            "Kickbacks",
            whole(gates.kickbacks.sumOf { it.count }),
            if (upheld + overturned > 0) "challenge upheld $upheld, overturned $overturned" else null,
        ),
        Tile(
            "People pulled in",
            whole(gates.touchpoints.sumOf { it.count }),
            "$asked ${if (asked == 1L) "question" else "questions"}, ${gates.questions.answered} answered",
        ),
        Tile("Loop stops", whole(gates.loopStops)),
    )
}

fun failureLabel(failure: ProjectGateFailureFailureClass): String =
    when (failure) {
        ProjectGateFailureFailureClass.VERIFIER -> "A verifier rejected the work"
        ProjectGateFailureFailureClass.REPORT_REJECTED -> "Its report was rejected"
        ProjectGateFailureFailureClass.SCHEMA_INVALID -> "Its result did not parse"
        ProjectGateFailureFailureClass.NO_REPORT -> "It never reported"
        ProjectGateFailureFailureClass.RESULT_DROPPED -> "Its result was lost"
        ProjectGateFailureFailureClass.BUDGET -> "Ran out of budget"
        ProjectGateFailureFailureClass.ENGINE -> "The engine failed"
        ProjectGateFailureFailureClass.ENGINE_API -> "The model API refused it"
        ProjectGateFailureFailureClass.HOST_LOST -> "Its host was lost"
        ProjectGateFailureFailureClass.LOOP -> "Stopped in a loop"
        ProjectGateFailureFailureClass.ERROR -> "The stage threw"
        ProjectGateFailureFailureClass.UNKNOWN -> "Another reason"
    }

fun touchpointLabel(cause: ProjectGateTouchpointCause): String =
    when (cause) {
        ProjectGateTouchpointCause.QUESTION -> "Asked a question"
        ProjectGateTouchpointCause.KICKBACK_LIMIT -> "Out of retries"
        ProjectGateTouchpointCause.OVER_BUDGET -> "Over its budget"
        ProjectGateTouchpointCause.CONTEXT_OVERFLOW -> "Prompt too large"
        ProjectGateTouchpointCause.REBASE_CONFLICT -> "Rebase conflict"
        ProjectGateTouchpointCause.POISONED -> "Poisoned"
        ProjectGateTouchpointCause.DEAD -> "Job died"
        ProjectGateTouchpointCause.SOURCE_CLOSED -> "Ticket closed"
        ProjectGateTouchpointCause.PROCESS_FAILURE -> "Held for a process fault"
        ProjectGateTouchpointCause.UNKNOWN -> "Another reason"
    }

fun conversationLabel(kind: ProjectConversationStatsKind): String =
    when (kind) {
        ProjectConversationStatsKind.PLANNING -> "Planning"
        ProjectConversationStatsKind.REVIEW -> "Review"
        ProjectConversationStatsKind.UNKNOWN -> "Other"
    }

private fun capitalized(text: String): String = text.replaceFirstChar { it.uppercaseChar() }

fun kickbackLabel(kickback: ProjectGateKickback): String {
    val step = kickback.step?.takeIf { it.isNotEmpty() }
    return if (kickback.reason == ProjectGateKickbackReason.VERIFIER) {
        if (step != null) "${capitalized(step)} rejected it" else "A verifier rejected it"
    } else {
        if (step != null) "${capitalized(step)} upheld a revise" else "Asked for changes"
    }
}

/** A count, saying how much of it is an older event placed by matching its text. */
fun countWithMatched(count: Long, matched: Long): String = if (matched > 0) "$count ($matched matched)" else "$count"

fun matchedNote(matched: Long): String? =
    if (matched > 0) {
        "$matched older failed attempts do not say why they failed, so they are placed by matching their text. " +
            "Those that match nothing count as a verifier's rejection."
    } else {
        null
    }
