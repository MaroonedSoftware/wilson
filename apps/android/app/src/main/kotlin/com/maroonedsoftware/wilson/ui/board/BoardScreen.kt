package com.maroonedsoftware.wilson.ui.board

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.maroonedsoftware.wilson.board.cardState
import com.maroonedsoftware.wilson.sdk.models.CardSummary
import com.maroonedsoftware.wilson.ui.Centered
import com.maroonedsoftware.wilson.ui.Loading
import com.maroonedsoftware.wilson.ui.StateIcon

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoardScreen(model: BoardModel, onCard: (project: String, id: String) -> Unit, onNewCard: (project: String) -> Unit, onChat: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(state.project) {
        val project = state.project ?: return@LaunchedEffect
        // Each time this screen comes back: the feed says nothing about what happened while it was away.
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            model.refresh()
            model.follow(project)
        }
    }
    Scaffold(
        floatingActionButton = {
            state.project?.let { project -> ExtendedFloatingActionButton(onClick = { onNewCard(project) }) { Text("New card") } }
        },
        topBar = {
            TopAppBar(
                title = { ProjectSwitcher(state, model::selectProject) },
                actions = {
                    TextButton(onClick = onChat) { Text("Chat") }
                    TextButton(onClick = model::signOut) { Text("Sign out") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                FilterChip(selected = state.flaggedOnly, onClick = model::toggleFlagged, label = { Text("Needs you (${state.flagged.size})") })
                Text(if (state.live) "live" else "reconnecting", style = MaterialTheme.typography.labelSmall)
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
            when {
                !state.loaded -> Loading()
                state.project == null -> Centered { Text("No projects are registered yet.") }
                state.flaggedOnly -> Cards(state.flagged, state, model, onCard)
                else -> Columns(state, model, onCard)
            }
        }
    }
}

@Composable
private fun ProjectSwitcher(state: BoardState, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    TextButton(onClick = { open = true }) { Text(state.project ?: "wilson", style = MaterialTheme.typography.titleLarge) }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        state.projects.forEach { name ->
            DropdownMenuItem(text = { Text(name) }, onClick = { open = false; onSelect(name) })
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Columns(state: BoardState, model: BoardModel, onCard: (String, String) -> Unit) {
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    val column = selected?.takeIf { it in state.columns } ?: state.columns.firstOrNull { state.cards[it].orEmpty().isNotEmpty() } ?: state.columns.firstOrNull()
    if (column == null) return Centered { Text("This board has no columns.") }
    PrimaryScrollableTabRow(selectedTabIndex = state.columns.indexOf(column), edgePadding = 8.dp) {
        state.columns.forEach { name ->
            Tab(selected = name == column, onClick = { selected = name }, text = { Text("$name ${state.cards[name].orEmpty().size}") })
        }
    }
    Cards(state.cards[column].orEmpty(), state, model, onCard)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Cards(cards: List<CardSummary>, state: BoardState, model: BoardModel, onCard: (String, String) -> Unit) {
    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = model::refresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize()) {
            items(cards, key = { it.id }) { card ->
                CardRow(card) { state.project?.let { onCard(it, card.id) } }
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun CardRow(card: CardSummary, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        cardState(card.needsHuman, card.stage)?.let { StateIcon(it) }
        Column {
            Text("${card.id}  ${card.title}", style = MaterialTheme.typography.bodyLarge)
            card.needsHumanReason?.takeIf { card.needsHuman }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, maxLines = 2)
            }
        }
    }
}
