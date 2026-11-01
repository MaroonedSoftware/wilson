package com.maroonedsoftware.wilson.board

import com.maroonedsoftware.wilson.sdk.models.ActivityEvent
import kotlin.time.Duration
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** What kind of thing happened, which decides the colour of a row's dot. */
enum class ActivityTone { GOOD, BAD, WARNING, INFO, QUIET }

/** How an activity row reads. */
data class ActivitySummary(val label: String, val tone: ActivityTone)

/** The same wording as the web app's `lib/activity.ts`. `{stage}` is filled in from the event. */
private val SUMMARIES = mapOf(
    "stage.dispatched" to ActivitySummary("Started {stage}", ActivityTone.INFO),
    "stage.placed" to ActivitySummary("Placed {stage} on a host", ActivityTone.INFO),
    "stage.host-lost" to ActivitySummary("Lost the host running {stage}", ActivityTone.WARNING),
    "stage.passed" to ActivitySummary("Passed {stage}", ActivityTone.GOOD),
    "stage.failed" to ActivitySummary("Failed {stage}", ActivityTone.BAD),
    "stage.poisoned" to ActivitySummary("Poisoned in {stage}", ActivityTone.BAD),
    "stage.dead" to ActivitySummary("Gave up on {stage}", ActivityTone.BAD),
    "stage.stale" to ActivitySummary("Abandoned a stale {stage} run", ActivityTone.WARNING),
    "test.flaky" to ActivitySummary("Found a flaky test", ActivityTone.WARNING),
    "rebase.conflict" to ActivitySummary("Hit a rebase conflict", ActivityTone.BAD),
    "context.overflow" to ActivitySummary("Ran out of context in {stage}", ActivityTone.BAD),
    "dispatch.deferred" to ActivitySummary("Deferred dispatch", ActivityTone.QUIET),
    "engine.failed" to ActivitySummary("Engine failed in {stage}", ActivityTone.BAD),
    "turn.empty" to ActivitySummary("Engine ended its turn without working", ActivityTone.WARNING),
    "scope.requested" to ActivitySummary("Requested more scope", ActivityTone.INFO),
    "scope.granted" to ActivitySummary("Scope granted", ActivityTone.GOOD),
    "scope.refused" to ActivitySummary("Scope refused", ActivityTone.WARNING),
    "work.committed" to ActivitySummary("Committed work", ActivityTone.GOOD),
    "transition.failed" to ActivitySummary("Could not move the card", ActivityTone.BAD),
    "chain.stopped" to ActivitySummary("Stopped after {stage}", ActivityTone.QUIET),
    "card.flagged" to ActivitySummary("Flagged for a human", ActivityTone.BAD),
    "card.acked" to ActivitySummary("Flag acknowledged", ActivityTone.GOOD),
    "card.over-budget" to ActivitySummary("Went over budget", ActivityTone.BAD),
    "card.auto-split" to ActivitySummary("Split automatically", ActivityTone.INFO),
    "card.plan-drafted" to ActivitySummary("Drafted a plan", ActivityTone.GOOD),
    "job.orphaned" to ActivitySummary("Recovered an orphaned job", ActivityTone.WARNING),
)

private fun JsonElement.text(key: String): String? = ((this as? JsonObject)?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

/** One event as a sentence. A type with no wording shows as recorded, so a later one still appears. */
fun summarizeActivity(type: String, stage: String?, payload: JsonElement): ActivitySummary {
    if (type == "transition.written") {
        val to = payload.text("to")
        return if (to != null && to != payload.text("from")) ActivitySummary("Moved to $to", ActivityTone.INFO) else ActivitySummary("Updated the card", ActivityTone.QUIET)
    }
    val summary = SUMMARIES[type] ?: return ActivitySummary(type, ActivityTone.QUIET)
    return summary.copy(label = summary.label.replace("{stage}", stage ?: "a stage"))
}

/** Why it happened, when the event recorded a reason. */
fun activityReason(payload: JsonElement): String? = payload.text("reason")?.takeIf { it.isNotEmpty() }

/**
 * Folds a fresh newest page into what is held. A live update only re-reads the newest page, so the
 * older pages someone has loaded must survive it. A fresh event replaces its held copy.
 */
fun mergeNewest(held: List<ActivityEvent>, fresh: List<ActivityEvent>): List<ActivityEvent> {
    val ids = fresh.mapTo(HashSet()) { it.id }
    return fresh + held.filter { it.id !in ids }
}

/**
 * Whether a full fresh page shares nothing with what is held, which means more happened than one page
 * holds. Merging would hide the events in between, so the held rows are dropped and read again by paging.
 */
fun leavesGap(held: List<ActivityEvent>, fresh: List<ActivityEvent>, pageSize: Long): Boolean {
    val ids = held.mapTo(HashSet()) { it.id }
    return held.isNotEmpty() && fresh.size >= pageSize && fresh.none { it.id in ids }
}

/** How long ago, in the fewest words. A clock a little behind the server's reads as now. */
fun activityAge(age: Duration): String =
    when {
        age.inWholeSeconds < 60 -> "now"
        age.inWholeMinutes < 60 -> "${age.inWholeMinutes}m"
        age.inWholeHours < 24 -> "${age.inWholeHours}h"
        else -> "${age.inWholeDays}d"
    }
