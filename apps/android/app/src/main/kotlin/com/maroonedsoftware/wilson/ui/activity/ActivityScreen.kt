package com.maroonedsoftware.wilson.ui.activity

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.maroonedsoftware.wilson.board.ActivityTone
import com.maroonedsoftware.wilson.board.activityAge
import com.maroonedsoftware.wilson.board.activityReason
import com.maroonedsoftware.wilson.board.summarizeActivity
import com.maroonedsoftware.wilson.sdk.models.ActivityEvent
import com.maroonedsoftware.wilson.ui.Centered
import com.maroonedsoftware.wilson.ui.Loading
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.delay

private const val AGE_TICK_MS = 10_000L

private fun ActivityTone.colour() =
    when (this) {
        ActivityTone.GOOD -> Color(0xFF2F9E44)
        ActivityTone.BAD -> Color(0xFFE03131)
        ActivityTone.WARNING -> Color(0xFFE8590C)
        ActivityTone.INFO -> Color(0xFF1C7ED6)
        ActivityTone.QUIET -> Color(0xFF868E96)
    }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivityScreen(model: ActivityModel, onBack: () -> Unit, onCard: (String) -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var now by remember { mutableStateOf(Clock.System.now()) }
    // Reads afresh on every return, since the feed reports only what follows.
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            model.refresh()
            model.follow()
        }
    }
    LaunchedEffect(Unit) {
        while (true) {
            delay(AGE_TICK_MS)
            now = Clock.System.now()
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Activity") }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
            when {
                !state.loaded -> Loading()
                state.events.isEmpty() -> Centered { Text("Nothing has happened in this project yet.") }
                else ->
                    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = model::refresh, modifier = Modifier.fillMaxSize()) {
                        LazyColumn(Modifier.fillMaxSize()) {
                            items(state.events, key = { it.id }) { event ->
                                Row(event, now) { onCard(event.cardId) }
                                HorizontalDivider()
                            }
                            if (state.hasOlder) {
                                item {
                                    TextButton(onClick = model::loadOlder, enabled = !state.loadingOlder, modifier = Modifier.fillMaxWidth()) {
                                        Text(if (state.loadingOlder) "Loading…" else "Show older")
                                    }
                                }
                            }
                        }
                    }
            }
        }
    }
}

@Composable
private fun Row(event: ActivityEvent, now: Instant, onClick: () -> Unit) {
    val summary = summarizeActivity(event.type, event.stage, event.payload)
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.padding(top = 6.dp).size(8.dp).background(summary.tone.colour(), CircleShape))
        Column(Modifier.weight(1f)) {
            Text("${summary.label} on ${event.cardTitle ?: event.cardId}", style = MaterialTheme.typography.bodyMedium)
            activityReason(event.payload)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Text(activityAge(now - event.createdAt), style = MaterialTheme.typography.labelSmall)
    }
}
