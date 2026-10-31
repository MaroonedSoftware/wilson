package com.maroonedsoftware.wilson.ui.card

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.maroonedsoftware.wilson.sdk.models.CardDetail
import com.maroonedsoftware.wilson.ui.Loading
import com.maroonedsoftware.wilson.ui.Problem

private val TABS = listOf("Plan", "Activity", "Diff")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CardScreen(model: CardModel, onBack: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val snackbars = remember { SnackbarHostState() }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.follow() } }
    LaunchedEffect(tab) { if (tab == 2 && state.diff == null) model.loadDiff() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.card?.id ?: "", maxLines = 1) },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { padding ->
        val card = state.card
        if (card == null) {
            Column(Modifier.padding(padding)) { state.error?.let { Problem(it) } ?: Loading() }
            return@Scaffold
        }
        Column(Modifier.padding(padding).fillMaxSize()) {
            Header(card)
            PrimaryTabRow(selectedTabIndex = tab) {
                TABS.forEachIndexed { index, name -> Tab(selected = tab == index, onClick = { tab = index }, text = { Text(name) }) }
            }
            when (tab) {
                0 -> Scrolling { SelectionContainer { Text(card.body) } }
                1 -> Scrolling { Activity(state) }
                else -> Diff(state)
            }
        }
    }
}

@Composable
private fun Header(card: CardDetail) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(card.title, style = MaterialTheme.typography.titleMedium)
        Text(card.stage + (card.branch?.let { "  ·  $it" } ?: ""), style = MaterialTheme.typography.bodySmall)
        if (card.needsHuman) Text(card.needsHumanReason ?: "This card is flagged for a human.", color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun Scrolling(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
}

@Composable
private fun Activity(state: CardState) {
    state.usage?.let { usage ->
        Text("${usage.total.attempts} attempts, ${usage.total.inputTokens} in, ${usage.total.outputTokens} out", style = MaterialTheme.typography.labelMedium)
        usage.stages.forEach { Text("${it.stage}: ${it.attempts} attempts, ${it.inputTokens} in, ${it.outputTokens} out", style = MaterialTheme.typography.bodySmall) }
    }
    state.events.forEach { event ->
        Text("${event.createdAt}  ${event.type}${event.stage?.let { " ($it)" } ?: ""}", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun Diff(state: CardState) {
    val diff = state.diff
    when {
        state.diffError != null -> Problem(state.diffError)
        diff == null -> Loading()
        diff.files.isEmpty() -> Scrolling { Text("No changes against ${diff.base}.") }
        else ->
            Scrolling {
                diff.files.forEach { file ->
                    Text("${file.path}${if (file.truncated) " (truncated)" else ""}", style = MaterialTheme.typography.labelLarge)
                    SelectionContainer(Modifier.horizontalScroll(rememberScrollState())) {
                        Text(file.patch, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                    }
                }
                if (diff.truncated) Text("This diff was too long to show in full.")
            }
    }
}
