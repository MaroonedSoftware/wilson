package com.maroonedsoftware.wilson.ui.plan

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.maroonedsoftware.wilson.sdk.models.PlanTurnRequestMode
import com.maroonedsoftware.wilson.sdk.models.PlanTurnRole
import com.maroonedsoftware.wilson.ui.Loading
import com.maroonedsoftware.wilson.ui.Problem

private val TABS = listOf("Conversation", "Draft", "Comments")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlanScreen(model: PlanModel, heading: String, onBack: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val snackbars = remember { SnackbarHostState() }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    LaunchedEffect(state.open) { if (state.open) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.follow() } }
    LaunchedEffect(Unit) { model.notices.collect { snackbars.showSnackbar(it, withDismissAction = true, duration = SnackbarDuration.Long) } }
    LaunchedEffect(Unit) { model.finished.collect { onBack() } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(heading) },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = { TextButton(onClick = model::close, enabled = state.open) { Text("Close session") } },
            )
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { padding ->
        if (!state.open) {
            return@Scaffold Column(Modifier.padding(padding)) { state.error?.let { Problem(it) } ?: Loading() }
        }
        Column(Modifier.padding(padding).imePadding().fillMaxSize()) {
            PrimaryTabRow(selectedTabIndex = tab) {
                TABS.forEachIndexed { index, name -> Tab(selected = tab == index, onClick = { tab = index }, text = { Text(name) }) }
            }
            when (tab) {
                0 -> Conversation(state, model)
                1 -> Draft(state, model)
                else -> Comments(state, model)
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.ColumnScope.Conversation(state: PlanState, model: PlanModel) {
    val list = rememberLazyListState()
    LaunchedEffect(state.turns.size, state.pending.length, state.sent) {
        val last = list.layoutInfo.totalItemsCount - 1
        if (last >= 0) list.scrollToItem(last)
    }
    LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp), state = list, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(state.turns, key = { it.seq }) { turn ->
            Text(if (turn.role == PlanTurnRole.USER) "You" else "Wilson", style = MaterialTheme.typography.labelMedium)
            SelectionContainer { Text(turn.content) }
        }
        state.sent?.takeIf { it.isNotBlank() }?.let { sent ->
            item {
                Text("You", style = MaterialTheme.typography.labelMedium)
                Text(sent)
            }
        }
        if (state.pending.isNotEmpty()) item { Text(state.pending) }
    }
    state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(state.composer, model::type, label = { Text("Message") }, maxLines = 5, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { model.send() }, enabled = !state.sending) { Text(if (state.sending) "Working…" else "Send") }
            OutlinedButton(onClick = { model.send(PlanTurnRequestMode.CUTS) }, enabled = !state.sending) { Text("Cuts") }
            OutlinedButton(onClick = { model.send(PlanTurnRequestMode.DRAFT) }, enabled = !state.sending) { Text("Draft it") }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.ColumnScope.Draft(state: PlanState, model: PlanModel) {
    OutlinedTextField(state.draft, model::editDraft, modifier = Modifier.weight(1f).fillMaxWidth().padding(16.dp))
    Button(
        onClick = model::approve,
        enabled = state.draft.isNotBlank(),
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp).fillMaxWidth(),
    ) { Text("Approve as the plan") }
}

@Composable
private fun Comments(state: PlanState, model: PlanModel) {
    var quote by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }
    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        state.comments.forEach { comment ->
            Text("“${comment.quote}”", style = MaterialTheme.typography.bodySmall)
            Text(comment.text)
            if (comment.resolved) Text("Resolved", style = MaterialTheme.typography.labelSmall)
            else TextButton(onClick = { model.resolve(comment.id) }) { Text("Resolve") }
            HorizontalDivider()
        }
        OutlinedTextField(quote, { quote = it }, label = { Text("Text from the draft") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(text, { text = it }, label = { Text("Comment") }, modifier = Modifier.fillMaxWidth())
        Button(
            onClick = {
                model.comment(quote, text)
                quote = ""
                text = ""
            },
            enabled = quote.isNotBlank() && text.isNotBlank(),
        ) { Text("Add comment") }
    }
}
