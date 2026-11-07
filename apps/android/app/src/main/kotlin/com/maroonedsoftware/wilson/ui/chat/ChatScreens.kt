package com.maroonedsoftware.wilson.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.maroonedsoftware.wilson.sdk.models.ChatAttachment
import com.maroonedsoftware.wilson.sdk.models.ChatMessageRole
import com.maroonedsoftware.wilson.sdk.models.ChatPendingAction
import com.maroonedsoftware.wilson.sdk.models.ChatPendingActionStatus
import com.maroonedsoftware.wilson.sdk.models.ChatPendingQuestion
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
    val snackbars = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.follow() } }
    LaunchedEffect(Unit) { model.notices.collect { snackbars.showSnackbar(it, withDismissAction = true, duration = SnackbarDuration.Long) } }
    LaunchedEffect(state.messages.size, state.draft.length, state.sent, state.actions.size, state.questions.size) {
        val last = list.layoutInfo.totalItemsCount - 1
        if (last >= 0) list.scrollToItem(last)
    }
    Scaffold(
        topBar = {
            TopAppBar(title = { Text(state.thread?.title ?: "Chat", maxLines = 1) }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } })
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { padding ->
        Column(Modifier.padding(padding).imePadding().fillMaxSize()) {
            // As on web, a question waiting on the person takes the place of the follow-ups.
            val asking = state.questions.any { isUnanswered(it, model.now()) }
            val suggestions = state.messages.lastOrNull()?.suggestions.orEmpty().takeIf { !state.sending && !asking }.orEmpty()
            LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp), state = list, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(timeline(state.messages, state.actions, state.questions), key = { it.key }) { entry ->
                    when (entry) {
                        is ChatEntry.Said -> {
                            val message = entry.message
                            Text(if (message.role == ChatMessageRole.USER) "You" else "Wilson", style = MaterialTheme.typography.labelMedium)
                            message.attachments?.takeIf { it.isNotEmpty() }?.let { Images(it, model) }
                            SelectionContainer { Text(message.content) }
                            message.operations.forEach { Text("${if (it.ok) "✓" else "✗"} ${it.name}", style = MaterialTheme.typography.bodySmall) }
                        }
                        is ChatEntry.Proposal -> Proposed(entry.action, model)
                        is ChatEntry.Asked -> QuestionCard(entry.question, state.answering == entry.question.id, model)
                    }
                }
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

/** How tall an image is drawn in the conversation at most; tapping it opens it at the screen's size. */
private val TALLEST_IMAGE = 240.dp

/** A message's images, one under another, each scaled down to fit and never up. */
@Composable
private fun Images(attachments: List<ChatAttachment>, model: ChatModel) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        attachments.forEachIndexed { index, attachment -> MessageImage(imageCaption(index, attachments.size, attachment), attachment.id, model) }
    }
}

/**
 * One image: a placeholder while it loads, the image once it has, and its caption saying it failed when
 * it cannot be drawn. The caption is what a screen reader hears in every state.
 */
@Composable
private fun MessageImage(caption: String, attachmentId: String, model: ChatModel) {
    val load by remember(attachmentId) { model.image(attachmentId) }.collectAsStateWithLifecycle()
    var open by rememberSaveable(attachmentId) { mutableStateOf(false) }
    when (val current = load) {
        ImageLoad.Loading ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(TALLEST_IMAGE / 2)
                    .background(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.shapes.small)
                    .semantics { contentDescription = "$caption, loading" },
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }
        ImageLoad.Failed ->
            Text(
                "$caption — could not load",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, MaterialTheme.colorScheme.error, MaterialTheme.shapes.small)
                    .padding(12.dp),
            )
        is ImageLoad.Loaded -> {
            Image(
                current.image,
                contentDescription = caption,
                contentScale = ContentScale.Fit,
                alignment = Alignment.CenterStart,
                modifier = Modifier
                    .heightIn(max = TALLEST_IMAGE)
                    .clip(MaterialTheme.shapes.small)
                    .clickable(onClickLabel = "Open larger") { open = true },
            )
            if (open) Enlarged(current.image, caption) { open = false }
        }
    }
}

/** An image at the size of the screen, on black. A tap anywhere, or Back, closes it. */
@Composable
private fun Enlarged(image: ImageBitmap, caption: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black).clickable(onClickLabel = "Close", onClick = onClose), contentAlignment = Alignment.Center) {
            Image(image, contentDescription = caption, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
        }
    }
}

/** How tall a long value gets before it scrolls in its own box, so Confirm stays near the summary. */
private val TALLEST_VALUE = 280.dp

private val LABEL_WIDTH = 96.dp

/**
 * A change the chat wants to make. Nothing happens until it is confirmed here, and Confirm runs exactly
 * the operation and arguments shown, so every argument is on the card and the arguments as they will
 * really be sent are one press away. Once decided or expired it stays in the conversation, saying how it
 * went, because that is the only record on this screen of whether the change happened.
 */
@Composable
private fun Proposed(action: ChatPendingAction, model: ChatModel) {
    var raw by rememberSaveable(action.id) { mutableStateOf(false) }
    val fields = remember(action.arguments) { actionFields(action.arguments) }
    val outcome = actionOutcome(action, model.now())
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(action.summary, modifier = Modifier.weight(1f))
                outcome?.let {
                    val color = if (action.status == ChatPendingActionStatus.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
                    Text(it, style = MaterialTheme.typography.labelMedium, color = color)
                }
            }
            Text("Runs ${action.operation}${action.project?.let { " in $it" }.orEmpty()} as you.", style = MaterialTheme.typography.bodySmall)
            SelectionContainer {
                if (raw) LongValue(prettyArguments(action.arguments), ChatFieldKind.JSON) else Fields(fields)
            }
            if (fields.isNotEmpty()) {
                TextButton(onClick = { raw = !raw }) { Text(if (raw) "Show fields" else "Show raw JSON") }
            }
            if (outcome == null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { model.decide(action.id, DecideChatActionRequestDecision.CONFIRM) }) { Text("Confirm") }
                    OutlinedButton(onClick = { model.decide(action.id, DecideChatActionRequestDecision.DECLINE) }) { Text("Decline") }
                }
            }
            action.error?.let { error ->
                SelectionContainer { Text(error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

/**
 * A question the chat asked, answered here with a tap: its 1-4 prompts as radio buttons or checkboxes plus an
 * "Other" box, one Submit for all of it, enabled only once every prompt has an answer. Past its expiry, or once
 * dismissed by an ordinary message, it says so rather than offering a button the server would refuse. Once
 * answered it keeps what was chosen in the conversation, with no controls. As web's `ChatQuestionCard`.
 */
@Composable
private fun QuestionCard(question: ChatPendingQuestion, sending: Boolean, model: ChatModel) {
    var draft by remember(question.id) { mutableStateOf(QuestionDraft.empty(question.questions)) }
    val outcome = questionOutcome(question, model.now())
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row {
                Text("Wilson asks", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                outcome?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            question.questions.forEachIndexed { i, q ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(q.header, style = MaterialTheme.typography.titleSmall)
                    Text(q.text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (outcome != null) {
                        answerText(q, question.answers?.getOrNull(i))?.let { SelectionContainer { Text(it) } }
                    } else {
                        q.options.forEachIndexed { index, option ->
                            val picked = index in draft.chosen[i]
                            val pick = { draft = draft.choose(question.questions, i, index) }
                            Row(
                                Modifier.fillMaxWidth().selectable(selected = picked, enabled = !sending, onClick = pick),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                if (q.multiSelect) Checkbox(picked, onCheckedChange = null, enabled = !sending)
                                else RadioButton(picked, onClick = null, enabled = !sending)
                                Column(Modifier.padding(start = 8.dp).weight(1f)) {
                                    Text(option.label)
                                    if (option.description.isNotEmpty()) {
                                        Text(option.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                            }
                        }
                        OutlinedTextField(
                            draft.other[i],
                            { draft = draft.type(question.questions, i, it) },
                            label = { Text("Other") },
                            placeholder = { Text("Something else…") },
                            enabled = !sending,
                            maxLines = 4,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            if (outcome == null) {
                Button(onClick = { model.answer(question.id, draft.answers()) }, enabled = draft.complete && !sending) {
                    Text(if (sending) "…" else "Submit")
                }
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
