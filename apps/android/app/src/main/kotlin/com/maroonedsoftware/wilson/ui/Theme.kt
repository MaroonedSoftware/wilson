package com.maroonedsoftware.wilson.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Monochrome, as the brand guide and the web theme are: one colour, and stages carry their own. */
private val DarkColors = darkColorScheme(
    primary = Color(0xFFC9C9C9),
    onPrimary = Color(0xFF242424),
    background = Color(0xFF242424),
    surface = Color(0xFF2E2E2E),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF242424),
    onPrimary = Color(0xFFFFFFFF),
)

@Composable
fun WilsonTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors, content = content)
}
