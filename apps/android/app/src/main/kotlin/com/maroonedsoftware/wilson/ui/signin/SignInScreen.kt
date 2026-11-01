package com.maroonedsoftware.wilson.ui.signin

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun SignInScreen(model: SignInModel) {
    val state by model.state.collectAsStateWithLifecycle()
    BackHandler(enabled = state.step != SignInStep.SERVER) { model.back() }

    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, androidx.compose.ui.Alignment.CenterVertically),
    ) {
        Text("wilson", style = MaterialTheme.typography.headlineLarge)
        when (state.step) {
            SignInStep.SERVER -> {
                Field("Server address", state.server, KeyboardType.Uri, ImeAction.Go, model::checkServer) { v -> model.edit { it.copy(server = v) } }
                Submit("Continue", state.busy, model::checkServer)
            }
            SignInStep.PASSWORD -> {
                Text(state.server, style = MaterialTheme.typography.bodySmall)
                Field("Email", state.email, KeyboardType.Email, ImeAction.Next) { v -> model.edit { it.copy(email = v) } }
                Field("Password", state.password, KeyboardType.Password, ImeAction.Go, model::signIn, secret = true) { v -> model.edit { it.copy(password = v) } }
                Submit("Sign in", state.busy, model::signIn)
                TextButton(onClick = model::back) { Text("Use a different server") }
            }
            SignInStep.CODE -> {
                Text("Enter the code from your authenticator app.")
                Field("Code", state.code, KeyboardType.Number, ImeAction.Go, model::submitCode) { v -> model.edit { it.copy(code = v) } }
                Submit("Confirm", state.busy, model::submitCode)
            }
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

/** Autocorrect is off everywhere here: a keyboard that treats an address as prose puts a space after each dot. */
@Composable
private fun Field(
    label: String,
    value: String,
    keyboard: KeyboardType,
    action: ImeAction,
    onGo: () -> Unit = {},
    secret: Boolean = false,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = keyboard,
            imeAction = action,
        ),
        keyboardActions = KeyboardActions(onGo = { onGo() }),
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun Submit(label: String, busy: Boolean, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(if (busy) "Working…" else label) }
}
