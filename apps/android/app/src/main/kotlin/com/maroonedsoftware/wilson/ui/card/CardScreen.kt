package com.maroonedsoftware.wilson.ui.card

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.maroonedsoftware.wilson.board.PARKING_LOT
import com.maroonedsoftware.wilson.board.mergeStatusLine
import com.maroonedsoftware.wilson.board.mergeStatusWarns
import com.maroonedsoftware.wilson.board.planCheckLine
import com.maroonedsoftware.wilson.sdk.models.CardBlocked
import com.maroonedsoftware.wilson.sdk.models.CardDetail
import com.maroonedsoftware.wilson.sdk.models.CardSummaryPlanCheck
import com.maroonedsoftware.wilson.ui.Loading
import com.maroonedsoftware.wilson.ui.Problem

private val TABS = listOf("Plan", "Activity", "Diff")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CardScreen(model: CardModel, onBack: () -> Unit, onEdit: () -> Unit, onPlan: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val snackbars = remember { SnackbarHostState() }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    // Re-reads on every return, such as back from editing, since the feed only reports what follows.
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            model.reload()
            model.follow()
        }
    }
    LaunchedEffect(Unit) { model.notices.collect { snackbars.showSnackbar(it, withDismissAction = true, duration = SnackbarDuration.Long) } }
    LaunchedEffect(tab) { if (tab == 2 && state.diff == null) model.loadDiff() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.card?.id ?: "", maxLines = 1) },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = { TextButton(onClick = onEdit) { Text("Edit") } },
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
            card.blocked?.let { Question(it, enabled = state.acting == null, onAnswer = model::answer) }
            Actions(card, state, model, onPlan)
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
        planCheckLine(card.planCheck, card.planCheckReason)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        card.mergeStatus?.let {
            Text(
                mergeStatusLine(it),
                style = MaterialTheme.typography.bodySmall,
                color = if (mergeStatusWarns(it)) MaterialTheme.colorScheme.error else Color.Unspecified,
            )
        }
        if (card.needsHuman && card.blocked == null) Text(card.needsHumanReason ?: "This card is flagged for a human.", color = MaterialTheme.colorScheme.error)
    }
}

/**
 * A question a stage stopped to ask, and where to answer it. Bounded and scrolling, so a long question
 * cannot push the actions and tabs off a phone's screen. A likely answer fills the box rather than
 * sends, so it can be reworded, and the box keeps its text if the server refuses it.
 */
@Composable
private fun Question(blocked: CardBlocked, enabled: Boolean, onAnswer: (String) -> Unit) {
    var answer by rememberSaveable(blocked.askedAt.toString()) { mutableStateOf("") }
    Column(
        Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("${blocked.stage} stopped to ask", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
        Text(blocked.question, style = MaterialTheme.typography.bodyLarge)
        Text("Already tried: ${blocked.tried}", style = MaterialTheme.typography.bodySmall)
        blocked.options?.takeIf { it.isNotEmpty() }?.let { options ->
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                options.forEach { option -> OutlinedButton(onClick = { answer = option }) { Text(option) } }
            }
        }
        OutlinedTextField(value = answer, onValueChange = { answer = it }, label = { Text("Your answer") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { onAnswer(answer) }, enabled = enabled && answer.isNotBlank()) { Text("Send answer") }
    }
}

/**
 * Offered as the web app offers them: whatever applies is the server's to decide, and a refusal comes
 * back in its own words. Merge and release ask first, because a thumb is not a mouse.
 */
@Composable
private fun Actions(card: CardDetail, state: CardState, model: CardModel, onPlan: () -> Unit) {
    var confirming by remember { mutableStateOf<Confirm?>(null) }
    var moving by remember { mutableStateOf(false) }
    val idle = state.acting == null
    Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (card.needsHuman) Button(onClick = model::acknowledge, enabled = idle) { Text("Acknowledge") }
        if (card.stage == "planning" || card.stage == PARKING_LOT) OutlinedButton(onClick = onPlan) { Text("Plan") }
        OutlinedButton(onClick = model::start, enabled = idle) { Text("Start") }
        OutlinedButton(onClick = model::approve, enabled = idle) { Text("Approve plan") }
        if (card.planCheck == CardSummaryPlanCheck.REFUSED) OutlinedButton(onClick = model::split, enabled = idle) { Text("Split as proposed") }
        OutlinedButton(onClick = { confirming = Confirm.MERGE }, enabled = idle) { Text(if (state.acting == "merge") "Merging…" else "Merge") }
        OutlinedButton(onClick = { confirming = Confirm.RELEASE }, enabled = idle) { Text("Release") }
        Box {
            OutlinedButton(onClick = { moving = true }, enabled = idle && state.stages.isNotEmpty()) { Text("Move") }
            DropdownMenu(expanded = moving, onDismissRequest = { moving = false }) {
                state.stages.filter { it != card.stage }.forEach { stage ->
                    DropdownMenuItem(text = { Text(stage) }, onClick = { moving = false; model.move(stage) })
                }
            }
        }
    }
    confirming?.let { asked ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(asked.title) },
            text = { Text(asked.detail) },
            confirmButton = {
                TextButton(onClick = {
                    confirming = null
                    if (asked == Confirm.MERGE) model.merge() else model.release()
                }) { Text(asked.verb) }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text("Cancel") } },
        )
    }
}

private enum class Confirm(val title: String, val detail: String, val verb: String) {
    MERGE("Merge to main?", "This runs the project's tests, then lands the branch. It can take several minutes.", "Merge"),
    RELEASE("Release this card?", "This cancels the job carrying this card and releases its claim. The server refuses if a daemon may really be running it.", "Release"),
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
