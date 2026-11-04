package com.maroonedsoftware.wilson.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.maroonedsoftware.wilson.sdk.models.ChatMessageRole
import com.maroonedsoftware.wilson.sdk.models.ChatPendingAction
import com.maroonedsoftware.wilson.sdk.models.DecideChatActionRequestDecision
import com.maroonedsoftware.wilson.ui.Centered
import com.maroonedsoftware.wilson.ui.Loading
import com.maroonedsoftware.wilson.ui.Problem

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadsScreen(model: ThreadsModel, onBack: () -> Unit, onThread: (String) -> Unit) {
    val threads by model.threads.collectAsStateWithLifecycle()
    val error by model.error.collectAsStateWithLifecycle()
    LifecycleResumeEffect(Unit) {
        model.load()
        onPauseOrDispose { }
    }
    LaunchedEffect(Unit) { model.opened.collect(onThread) }
    Scaffold(
        topBar = { TopAppBar(title = { Text("Chat") }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }) },
        floatingActionButton = { ExtendedFloatingActionButton(onClick = model::start) { Text("New chat") } },
    ) { padding ->
        val list = threads
        Column(Modifier.padding(padding).fillMaxSize()) {
            when {
                error != null -> Problem(error.orEmpty())
                list == null -> Loading()
                list.isEmpty() -> Centered { Text("No chats yet.") }
                else ->
                    LazyColumn {
                        items(list, key = { it.id }) { thread ->
                            Text(thread.title, modifier = Modifier.fillMaxWidth().clickable { onThread(thread.id) }.padding(16.dp))
                            HorizontalDivider()
                        }
                    }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(model: ChatModel, onBack: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val list = rememberLazyListState()
    LaunchedEffect(Unit) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.follow() } }
    LaunchedEffect(state.messages.size, state.draft.length, state.sent, state.actions.size) {
        val last = list.layoutInfo.totalItemsCount - 1
        if (last >= 0) list.scrollToItem(last)
    }
    Scaffold(
        topBar = {
            TopAppBar(title = { Text(state.thread?.title ?: "Chat", maxLines = 1) }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } })
        },
    ) { padding ->
        Column(Modifier.padding(padding).imePadding().fillMaxSize()) {
            val suggestions = state.messages.lastOrNull()?.suggestions.orEmpty().takeIf { !state.sending }.orEmpty()
            LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp), state = list, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(state.messages, key = { it.seq }) { message ->
                    Text(if (message.role == ChatMessageRole.USER) "You" else "Wilson", style = MaterialTheme.typography.labelMedium)
                    imagesCaption(message.attachments.orEmpty().size)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    SelectionContainer { Text(message.content) }
                    message.operations.forEach { Text("${if (it.ok) "✓" else "✗"} ${it.name}", style = MaterialTheme.typography.bodySmall) }
                }
                items(state.actions.filter { isAwaiting(it, model.now()) }, key = { it.id }) { action -> Proposed(action, model) }
                state.sent?.let { item { Text("You", style = MaterialTheme.typography.labelMedium); Text(it) } }
                draftWithoutSuggestions(state.draft).takeIf { it.isNotEmpty() }?.let { item { Text(it) } }
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) }
            Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                suggestions.take(2).forEach { AssistChip(onClick = { model.send(it) }, label = { Text(it, maxLines = 1) }) }
            }
            Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(state.composer, model::type, label = { Text("Message") }, maxLines = 4, modifier = Modifier.weight(1f))
                Button(onClick = { model.send() }, enabled = !state.sending) { Text(if (state.sending) "…" else "Send") }
            }
        }
    }
}

/** How tall a long value gets before it scrolls in its own box, so Confirm stays near the summary. */
private val TALLEST_VALUE = 280.dp

private val LABEL_WIDTH = 96.dp

/**
 * A change the chat wants to make. Nothing happens until it is confirmed here, and Confirm runs exactly
 * the operation and arguments shown, so every argument is on the card and the arguments as they will
 * really be sent are one press away.
 */
@Composable
private fun Proposed(action: ChatPendingAction, model: ChatModel) {
    var raw by rememberSaveable(action.id) { mutableStateOf(false) }
    val fields = remember(action.arguments) { actionFields(action.arguments) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(action.summary)
            Text("Runs ${action.operation}${action.project?.let { " in $it" }.orEmpty()} as you.", style = MaterialTheme.typography.bodySmall)
            SelectionContainer {
                if (raw) LongValue(prettyArguments(action.arguments), ChatFieldKind.JSON) else Fields(fields)
            }
            if (fields.isNotEmpty()) {
                TextButton(onClick = { raw = !raw }) { Text(if (raw) "Show fields" else "Show raw JSON") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { model.decide(action.id, DecideChatActionRequestDecision.CONFIRM) }) { Text("Confirm") }
                OutlinedButton(onClick = { model.decide(action.id, DecideChatActionRequestDecision.DECLINE) }) { Text("Decline") }
            }
        }
    }
}

/** The short values beside their labels, then anything long under its own. */
@Composable
private fun Fields(fields: List<ChatActionField>) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        fields.forEach { field ->
            if (field.kind == ChatFieldKind.LINE) {
                Row {
                    FieldLabel(field.label, Modifier.width(LABEL_WIDTH).alignByBaseline())
                    Text(field.value, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).alignByBaseline())
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    FieldLabel(field.label)
                    LongValue(field.value, field.kind)
                }
            }
        }
    }
}

@Composable
private fun FieldLabel(label: String, modifier: Modifier = Modifier) {
    Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier)
}

/** Plain text in a box of capped height that scrolls on its own: there is no Markdown renderer here, and JSON keeps its indent in a fixed-width face. */
@Composable
private fun LongValue(value: String, kind: ChatFieldKind) {
    Text(
        value,
        style = MaterialTheme.typography.bodySmall,
        fontFamily = if (kind == ChatFieldKind.JSON) FontFamily.Monospace else null,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface, MaterialTheme.shapes.small)
            .heightIn(max = TALLEST_VALUE)
            .verticalScroll(rememberScrollState())
            .padding(8.dp),
    )
}
