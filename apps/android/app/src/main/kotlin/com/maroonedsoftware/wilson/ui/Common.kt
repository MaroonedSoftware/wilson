package com.maroonedsoftware.wilson.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.maroonedsoftware.wilson.R
import com.maroonedsoftware.wilson.board.ActivityTone
import com.maroonedsoftware.wilson.board.CardState

/** The app's one set of status colours, shared by the activity feed and the goals. */
fun ActivityTone.colour(): Color =
    when (this) {
        ActivityTone.GOOD -> Color(0xFF2F9E44)
        ActivityTone.BAD -> Color(0xFFE03131)
        ActivityTone.WARNING -> Color(0xFFE8590C)
        ActivityTone.INFO -> Color(0xFF1C7ED6)
        ActivityTone.QUIET -> Color(0xFF868E96)
    }

@Composable
fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) { content() }
}

@Composable
fun Loading() = Centered { CircularProgressIndicator() }

@Composable
fun Problem(message: String) = Centered { Text(message, color = MaterialTheme.colorScheme.error) }

@DrawableRes
private fun CardState.icon() =
    when (this) {
        CardState.PARKED -> R.drawable.ic_state_parked
        CardState.PASSED -> R.drawable.ic_state_passed
        CardState.NEEDS_HUMAN -> R.drawable.ic_state_needs_human
        CardState.POISONED -> R.drawable.ic_state_poisoned
    }

@Composable
fun StateIcon(state: CardState, modifier: Modifier = Modifier) {
    Image(painterResource(state.icon()), contentDescription = state.name.lowercase().replace('_', ' '), modifier = modifier.size(24.dp))
}
