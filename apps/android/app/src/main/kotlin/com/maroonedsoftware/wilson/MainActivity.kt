package com.maroonedsoftware.wilson

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.maroonedsoftware.wilson.ui.WilsonTheme
import com.maroonedsoftware.wilson.ui.signin.SignInModel
import com.maroonedsoftware.wilson.ui.signin.SignInScreen
import kotlinx.coroutines.launch

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

@Composable
private fun Root(app: WilsonApp) {
    val session by app.session.session.collectAsState(initial = null)
    val scope = rememberCoroutineScope()
    if (session == null) {
        SignInScreen(viewModel(factory = viewModelFactory { initializer { SignInModel(app) } }))
    } else {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Signed in as ${session?.email}")
                Button(onClick = { scope.launch { app.session.signOut() } }) { Text("Sign out") }
            }
        }
    }
}
