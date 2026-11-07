package com.maroonedsoftware.wilson.ui.stats

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.maroonedsoftware.wilson.sdk.models.ProjectDayStats
import com.maroonedsoftware.wilson.sdk.models.ProjectGateStats
import com.maroonedsoftware.wilson.sdk.models.ProjectStats
import com.maroonedsoftware.wilson.ui.Loading
import com.maroonedsoftware.wilson.ui.Problem

private val CHART_HEIGHT = 140.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StatsScreen(model: StatsModel, onBack: () -> Unit, onCard: (String) -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Reads afresh on every return, since the feed reports only what follows.
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            model.refresh()
            model.follow()
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Stats") }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                STATS_WINDOWS.forEachIndexed { index, days ->
                    SegmentedButton(
                        selected = state.days == days,
                        onClick = { model.select(days) },
                        shape = SegmentedButtonDefaults.itemShape(index, STATS_WINDOWS.size),
                    ) { Text("$days days") }
                }
            }
            val figures = state.figures
            val error = state.error
            if (figures == null) {
                if (error != null) Problem(error) else Loading()
            } else {
                // The figures stay below a failed re-read, as the activity page keeps its events.
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) }
                PullToRefreshBox(isRefreshing = state.loading, onRefresh = model::refresh, modifier = Modifier.fillMaxSize()) {
                    if (!hasRun(figures.stats)) {
                        // Scrollable, so the empty window can still be pulled to refresh.
                        LazyColumn(Modifier.fillMaxSize()) { item { Text("Nothing has run in this window.", modifier = Modifier.padding(24.dp)) } }
                    } else {
                        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            statsItems(figures.stats, figures.gates, onCard)
                        }
                    }
                }
            }
        }
    }
}

private fun LazyListScope.statsItems(stats: ProjectStats, gates: ProjectGateStats, onCard: (String) -> Unit) {
    item { Tiles(headlineTiles(stats, gates)) }
    item { Heading("Gates") }
    item { Tiles(gateTiles(gates)) }
    if (gates.kickbacks.isNotEmpty()) {
        item {
            Section("Kickbacks", gates.kickbacks.map { Line(kickbackLabel(it), countWithMatched(it.count, it.matched), it.stage) })
        }
    }
    if (gates.failures.isNotEmpty()) {
        item { Section("Why attempts failed", gates.failures.map { Line(failureLabel(it.failureClass), countWithMatched(it.count, it.matched)) }) }
    }
    if (gates.touchpoints.isNotEmpty()) {
        item { Section("Why a person was pulled in", gates.touchpoints.map { Line(touchpointLabel(it.cause), whole(it.count)) }) }
    }
    if (gates.rules.isNotEmpty()) {
        item { Section("Rules", gates.rules.map { Line(it.statement, "${it.failed} failed", "${it.unavailable} no verdict") }) }
    }
    matchedNote(gates.matched)?.let { item { Note(it) } }

    item { Daily(stats) }

    item { Heading("By stage") }
    stats.stages.forEach { stage ->
        item(key = "stage:${stage.stage}") {
            Block(stage.stage) {
                row("Attempts", "${stage.attempts}, ${perCard(stage.attempts, stage.cards)} per card")
                row("Passed", percent(stagePassRate(stage, gates.revised)))
                row("Interrupted", "${stage.interrupted}")
                tokens(stage.inputTokens, stage.cachedInputTokens, stage.outputTokens)
            }
        }
    }

    if (hasConversations(stats)) {
        item { Heading("Planning and review") }
        stats.conversations.forEach { conversation ->
            item(key = "conversation:${conversation.kind}") {
                Block(conversationLabel(conversation.kind)) {
                    row("Turns", "${conversation.turns} on ${conversation.cards} ${if (conversation.cards == 1L) "card" else "cards"}")
                    tokens(conversation.inputTokens, conversation.cachedInputTokens, conversation.outputTokens)
                }
            }
        }
    }

    item { Heading("Cards that wrote the most") }
    stats.topCards.forEach { card ->
        item(key = "card:${card.cardId}") {
            val title = card.cardTitle
            Row(
                Modifier.fillMaxWidth().let { if (title != null) it.clickable { onCard(card.cardId) } else it }.padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(if (title != null) "${card.cardId}  $title" else "${card.cardId} (no longer on the board)", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "${card.attempts} attempts, ${whole(card.inputTokens)} in, ${whole(card.outputTokens)} out",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            HorizontalDivider()
        }
    }
    item { Spacer(Modifier.height(16.dp)) }
}

@Composable
private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp))
}

@Composable
private fun Note(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp))
}

/** Two tiles to a row, as web's grid on a narrow screen. */
@Composable
private fun Tiles(tiles: List<Tile>) {
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        tiles.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { tile ->
                    OutlinedCard(Modifier.weight(1f)) {
                        Column(Modifier.padding(12.dp).heightIn(min = 72.dp)) {
                            Text(tile.label, style = MaterialTheme.typography.labelMedium)
                            Text(tile.value, style = MaterialTheme.typography.headlineSmall)
                            tile.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

private data class Line(val label: String, val value: String, val detail: String? = null)

@Composable
private fun Section(title: String, lines: List<Line>) {
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge)
        lines.forEach { line ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(line.label, style = MaterialTheme.typography.bodyMedium)
                    line.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
                Text(line.value, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

private class BlockScope {
    val rows = mutableListOf<Pair<String, String>>()

    fun row(label: String, value: String) {
        rows += label to value
    }

    fun tokens(input: Long, cached: Long, output: Long) {
        row("Input tokens", "${whole(input)}, ${whole(cached)} cached")
        row("Output tokens", whole(output))
    }
}

/** A table row of web's, as a card: a phone has no room for eight columns. */
@Composable
private fun Block(title: String, content: BlockScope.() -> Unit) {
    val rows = BlockScope().apply(content).rows
    OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            rows.forEach { (label, value) ->
                Row {
                    Text(label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    Text(value, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun Daily(stats: ProjectStats) {
    var asList by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Output tokens per day", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = { asList = !asList }) { Text(if (asList) "Show as chart" else "Show as list") }
        }
        if (asList) DayList(stats.days) else DayChart(stats.days)
        Text("Days are counted in ${stats.zone}. This chart counts stage runs only.", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun DayChart(days: List<ProjectDayStats>) {
    val top = axisTop(days.maxOfOrNull { it.outputTokens } ?: 0L)
    val colour = MaterialTheme.colorScheme.primary
    Column(Modifier.semantics { contentDescription = "Output tokens per day, ${days.size} days" }) {
        Row(Modifier.fillMaxWidth().height(CHART_HEIGHT), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Column(Modifier.fillMaxHeight(), verticalArrangement = Arrangement.SpaceBetween, horizontalAlignment = Alignment.End) {
                listOf(top, top / 2, 0.0).forEach { Text(compactTokens(it.toLong()), style = MaterialTheme.typography.labelSmall) }
            }
            Row(Modifier.weight(1f).fillMaxHeight(), horizontalArrangement = Arrangement.spacedBy(1.dp), verticalAlignment = Alignment.Bottom) {
                days.forEach { day ->
                    Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.BottomCenter) {
                        if (day.outputTokens > 0) {
                            Box(
                                Modifier.fillMaxWidth()
                                    .fillMaxHeight((day.outputTokens / top).toFloat().coerceIn(0.015f, 1f))
                                    .background(colour, RoundedCornerShape(topStart = 2.dp, topEnd = 2.dp)),
                            )
                        }
                    }
                }
            }
        }
        if (days.isNotEmpty()) {
            Row(Modifier.fillMaxWidth()) {
                Text(dayLabel(days.first().date), style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
                Text(dayLabel(days.last().date), style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun DayList(days: List<ProjectDayStats>) {
    Column {
        days.forEach { day ->
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(dayLabel(day.date), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                Column(horizontalAlignment = Alignment.End) {
                    Text("${day.attempts} attempts, ${day.failed} failed", style = MaterialTheme.typography.bodySmall)
                    Text(
                        "${whole(day.inputTokens)} in (${whole(day.cachedInputTokens)} cached), ${whole(day.outputTokens)} out",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            HorizontalDivider()
        }
    }
}
