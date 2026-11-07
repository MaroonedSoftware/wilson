package com.maroonedsoftware.wilson.ui.goal

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.maroonedsoftware.wilson.sdk.models.Goal
import com.maroonedsoftware.wilson.sdk.models.GoalCard
import com.maroonedsoftware.wilson.ui.Centered
import com.maroonedsoftware.wilson.ui.Loading
import com.maroonedsoftware.wilson.ui.Problem
import com.maroonedsoftware.wilson.ui.colour

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoalsScreen(model: GoalsModel, onBack: () -> Unit, onGoal: (String) -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    // Reads afresh on every return: /api/goals publishes nothing of its own to follow.
    LifecycleResumeEffect(Unit) {
        model.refresh()
        onPauseOrDispose { }
    }
    Scaffold(
        topBar = { TopAppBar(title = { Text("Goals") }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }) },
    ) { padding ->
        val goals = state.goals
        Column(Modifier.padding(padding).fillMaxSize()) {
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
            if (goals == null) {
                Loading()
            } else {
                val (open, finished) = partitionGoals(goals)
                // The empty state sits inside the pull too, so a goal started meanwhile can be pulled in.
                PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = model::refresh, modifier = Modifier.fillMaxSize()) {
                    LazyColumn(Modifier.fillMaxSize()) {
                        if (goals.isEmpty()) {
                            item(key = "empty") {
                                Box(Modifier.fillParentMaxSize()) {
                                    Centered { Text("No goals yet. Ask the chat to start one for work that will take several cards.") }
                                }
                            }
                        }
                        items(open, key = { it.id }) { goal ->
                            GoalRow(goal) { onGoal(goal.id) }
                            HorizontalDivider()
                        }
                        if (finished.isNotEmpty()) {
                            item(key = "finished") {
                                Text("Finished", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp))
                            }
                            items(finished, key = { it.id }) { goal ->
                                GoalRow(goal) { onGoal(goal.id) }
                                HorizontalDivider()
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GoalRow(goal: Goal, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(goal.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(goal.outcome, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(goal.project, style = MaterialTheme.typography.labelSmall)
            Text(statusWord(goal.status), style = MaterialTheme.typography.labelSmall, color = goalTone(goal.status).colour())
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoalScreen(model: GoalModel, onBack: () -> Unit, onCard: (project: String, id: String) -> Unit, onConversation: (String) -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val snackbars = remember { SnackbarHostState() }
    // Re-reads on every return, such as back from one of its cards, since the feed only reports what follows.
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            model.reload()
            model.follow()
        }
    }
    LaunchedEffect(Unit) { model.notices.collect { snackbars.showSnackbar(it, withDismissAction = true, duration = SnackbarDuration.Long) } }

    val goal = state.detail?.goal
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(goal?.title ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = { goal?.let { TextButton(onClick = { onConversation(it.threadId) }) { Text("Conversation") } } },
            )
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { padding ->
        val detail = state.detail
        if (detail == null || goal == null) {
            Column(Modifier.padding(padding)) { state.error?.let { Problem(it) } ?: Loading() }
            return@Scaffold
        }
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) }
            Column(Modifier.padding(horizontal = 16.dp).padding(top = 16.dp)) {
                Text(statusWord(goal.status), style = MaterialTheme.typography.labelLarge, color = goalTone(goal.status).colour())
                Text(goal.project, style = MaterialTheme.typography.bodySmall)
            }
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("What done looks like", style = MaterialTheme.typography.labelMedium)
                SelectionContainer { Text(goal.outcome) }
            }
            val actions = goalActions(goal.status)
            if (actions.isNotEmpty()) {
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    actions.forEach { action -> OutlinedButton(onClick = { model.change(action) }, enabled = !state.acting) { Text(action.label) } }
                }
            }
            Text("Cards", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 16.dp))
            if (detail.cards.isEmpty()) {
                Text("No cards yet. Ask in the conversation to add some.", modifier = Modifier.padding(horizontal = 16.dp).padding(bottom = 16.dp))
            } else {
                Column {
                    detail.cards.forEach { card ->
                        CardRow(card) { onCard(goal.project, card.id) }
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

@Composable
private fun CardRow(card: GoalCard, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp)) {
        Text("${card.id}  ${card.title}", style = MaterialTheme.typography.bodyMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(card.stage, style = MaterialTheme.typography.bodySmall)
            if (card.needsHuman) Text("needs you", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
    }
}
