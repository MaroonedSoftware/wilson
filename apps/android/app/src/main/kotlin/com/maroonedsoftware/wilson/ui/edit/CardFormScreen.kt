package com.maroonedsoftware.wilson.ui.edit

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.maroonedsoftware.wilson.ui.Loading

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CardFormScreen(model: CardFormModel, heading: String, onBack: () -> Unit, onSaved: (String) -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { model.saved.collect(onSaved) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(heading) },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = { TextButton(onClick = model::save, enabled = state.loaded && !state.busy) { Text("Save") } },
            )
        },
    ) { padding ->
        if (!state.loaded && state.error == null) return@Scaffold Column(Modifier.padding(padding)) { Loading() }
        Column(Modifier.padding(padding).imePadding().fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            OutlinedTextField(state.title, { v -> model.edit { it.copy(title = v) } }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(state.body, { v -> model.edit { it.copy(body = v) } }, label = { Text("Body") }, modifier = Modifier.fillMaxWidth().weight(1f))
        }
    }
}
