package com.maroonedsoftware.wilson

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.maroonedsoftware.wilson.push.EXTRA_CARD
import com.maroonedsoftware.wilson.push.EXTRA_PROJECT
import com.maroonedsoftware.wilson.ui.WilsonTheme
import com.maroonedsoftware.wilson.ui.activity.ActivityModel
import com.maroonedsoftware.wilson.ui.activity.ActivityScreen
import com.maroonedsoftware.wilson.ui.board.BoardModel
import com.maroonedsoftware.wilson.ui.board.BoardScreen
import com.maroonedsoftware.wilson.ui.card.CardModel
import com.maroonedsoftware.wilson.ui.card.CardScreen
import com.maroonedsoftware.wilson.ui.chat.ChatModel
import com.maroonedsoftware.wilson.ui.chat.ChatScreen
import com.maroonedsoftware.wilson.ui.chat.ThreadsModel
import com.maroonedsoftware.wilson.ui.chat.ThreadsScreen
import com.maroonedsoftware.wilson.ui.edit.CardFormModel
import com.maroonedsoftware.wilson.ui.edit.CardFormScreen
import com.maroonedsoftware.wilson.ui.nav.Destination
import com.maroonedsoftware.wilson.ui.nav.NavConfiguration
import com.maroonedsoftware.wilson.ui.plan.PlanModel
import com.maroonedsoftware.wilson.ui.plan.PlanScreen
import com.maroonedsoftware.wilson.ui.signin.SignInModel
import com.maroonedsoftware.wilson.ui.signin.SignInScreen
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map

class MainActivity : ComponentActivity() {
    /** The card a tapped notification named, until the back stack has taken it. */
    private val opening = MutableStateFlow<Destination.Card?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as WilsonApp
        // Only on a fresh start: a rotation would otherwise reopen the card from the same intent.
        if (savedInstanceState == null) read(intent)
        setContent {
            WilsonTheme {
                Surface(modifier = Modifier.fillMaxSize()) { Root(app, opening) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        read(intent)
    }

    private fun read(intent: Intent) {
        val project = intent.getStringExtra(EXTRA_PROJECT)
        val card = intent.getStringExtra(EXTRA_CARD)
        if (project != null && card != null) opening.value = Destination.Card(project, card)
    }
}

/** Sends this install's token now that there is a session, and asks to show notifications on Android 13+. */
@Composable
private fun AskForPush(app: WilsonApp) {
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ask.launch(Manifest.permission.POST_NOTIFICATIONS)
        app.push.register()
    }
}

/** A value around the stored session, so "still reading the disk" is not mistaken for "signed out". */
private class Read(val session: StoredSession?)

@Composable
private fun Root(app: WilsonApp, opening: MutableStateFlow<Destination.Card?>) {
    val read by remember { app.session.session.map(::Read) }.collectAsState(initial = null)
    val current = read ?: return
    if (current.session == null) {
        SignInScreen(viewModel(factory = viewModelFactory { initializer { SignInModel(app) } }))
    } else {
        SignedIn(app, opening)
    }
}

@Composable
private fun SignedIn(app: WilsonApp, opening: MutableStateFlow<Destination.Card?>) {
    val backStack = rememberNavBackStack(NavConfiguration, Destination.Board)
    val card by opening.collectAsState()
    LaunchedEffect(card) {
        card?.let {
            if (backStack.lastOrNull() != it) backStack.add(it)
            opening.value = null
        }
    }
    AskForPush(app)
    NavDisplay(
        backStack = backStack,
        onBack = { backStack.removeLastOrNull() },
        entryProvider = entryProvider {
            entry<Destination.Board> {
                BoardScreen(
                    viewModel(factory = viewModelFactory { initializer { BoardModel(app) } }),
                    onCard = { project, id -> backStack.add(Destination.Card(project, id)) },
                    onNewCard = { project -> backStack.add(Destination.NewCard(project)) },
                    onChat = { backStack.add(Destination.Threads) },
                    onActivity = { project -> backStack.add(Destination.Activity(project)) },
                )
            }
            entry<Destination.Activity> { key ->
                ActivityScreen(
                    viewModel(key = "activity:${key.project}", factory = viewModelFactory { initializer { ActivityModel(app, key.project) } }),
                    onBack = { backStack.removeLastOrNull() },
                    onCard = { id -> backStack.add(Destination.Card(key.project, id)) },
                )
            }
            entry<Destination.Threads> {
                ThreadsScreen(
                    viewModel(factory = viewModelFactory { initializer { ThreadsModel(app) } }),
                    onBack = { backStack.removeLastOrNull() },
                    onThread = { id -> backStack.add(Destination.Chat(id)) },
                )
            }
            entry<Destination.Chat> { key ->
                ChatScreen(
                    viewModel(key = "chat:${key.id}", factory = viewModelFactory { initializer { ChatModel(app, key.id) } }),
                    onBack = { backStack.removeLastOrNull() },
                )
            }
            entry<Destination.Card> { key ->
                CardScreen(
                    viewModel(key = "card:${key.project}:${key.id}", factory = viewModelFactory { initializer { CardModel(app, key.project, key.id) } }),
                    onBack = { backStack.removeLastOrNull() },
                    onEdit = { backStack.add(Destination.EditCard(key.project, key.id)) },
                    onPlan = { backStack.add(Destination.Plan(key.project, key.id)) },
                )
            }
            entry<Destination.Plan> { key ->
                PlanScreen(
                    viewModel(key = "plan:${key.project}:${key.id}", factory = viewModelFactory { initializer { PlanModel(app, key.project, key.id) } }),
                    heading = "Plan ${key.id}",
                    onBack = { backStack.removeLastOrNull() },
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
