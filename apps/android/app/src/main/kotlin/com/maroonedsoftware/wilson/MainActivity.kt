package com.maroonedsoftware.wilson

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.maroonedsoftware.wilson.auth.StoredSession
import com.maroonedsoftware.wilson.ui.WilsonTheme
import com.maroonedsoftware.wilson.ui.board.BoardModel
import com.maroonedsoftware.wilson.ui.board.BoardScreen
import com.maroonedsoftware.wilson.ui.card.CardModel
import com.maroonedsoftware.wilson.ui.card.CardScreen
import com.maroonedsoftware.wilson.ui.edit.CardFormModel
import com.maroonedsoftware.wilson.ui.edit.CardFormScreen
import com.maroonedsoftware.wilson.ui.nav.Destination
import com.maroonedsoftware.wilson.ui.nav.NavConfiguration
import com.maroonedsoftware.wilson.ui.signin.SignInModel
import com.maroonedsoftware.wilson.ui.signin.SignInScreen
import kotlinx.coroutines.flow.map

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as WilsonApp
        setContent {
            WilsonTheme {
                Surface(modifier = Modifier.fillMaxSize()) { Root(app) }
            }
        }
    }
}

/** A value around the stored session, so "still reading the disk" is not mistaken for "signed out". */
private class Read(val session: StoredSession?)

@Composable
private fun Root(app: WilsonApp) {
    val read by remember { app.session.session.map(::Read) }.collectAsState(initial = null)
    val current = read ?: return
    if (current.session == null) {
        SignInScreen(viewModel(factory = viewModelFactory { initializer { SignInModel(app) } }))
    } else {
        SignedIn(app)
    }
}

@Composable
private fun SignedIn(app: WilsonApp) {
    val backStack = rememberNavBackStack(NavConfiguration, Destination.Board)
    NavDisplay(
        backStack = backStack,
        onBack = { backStack.removeLastOrNull() },
        entryProvider = entryProvider {
            entry<Destination.Board> {
                BoardScreen(
                    viewModel(factory = viewModelFactory { initializer { BoardModel(app) } }),
                    onCard = { project, id -> backStack.add(Destination.Card(project, id)) },
                    onNewCard = { project -> backStack.add(Destination.NewCard(project)) },
                )
            }
            entry<Destination.Card> { key ->
                CardScreen(
                    viewModel(key = "card:${key.project}:${key.id}", factory = viewModelFactory { initializer { CardModel(app, key.project, key.id) } }),
                    onBack = { backStack.removeLastOrNull() },
                    onEdit = { backStack.add(Destination.EditCard(key.project, key.id)) },
                )
            }
            entry<Destination.NewCard> { key ->
                CardFormScreen(
                    viewModel(key = "new:${key.project}", factory = viewModelFactory { initializer { CardFormModel(app, key.project, null) } }),
                    heading = "New card",
                    onBack = { backStack.removeLastOrNull() },
                    onSaved = { id ->
                        backStack.removeLastOrNull()
                        backStack.add(Destination.Card(key.project, id))
                    },
                )
            }
            entry<Destination.EditCard> { key ->
                CardFormScreen(
                    viewModel(key = "edit:${key.project}:${key.id}", factory = viewModelFactory { initializer { CardFormModel(app, key.project, key.id) } }),
                    heading = "Edit ${key.id}",
                    onBack = { backStack.removeLastOrNull() },
                    onSaved = { backStack.removeLastOrNull() },
                )
            }
        },
    )
}
