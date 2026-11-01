package com.maroonedsoftware.wilson.ui.signin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.BuildConfig
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.SignInResult
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.net.Patience
import com.maroonedsoftware.wilson.net.ServerUrl
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class SignInStep { SERVER, PASSWORD, CODE }

data class SignInState(
    val step: SignInStep = SignInStep.SERVER,
    val server: String = "",
    val email: String = "",
    val password: String = "",
    val code: String = "",
    val busy: Boolean = false,
    val error: String? = null,
)

class SignInModel(private val app: WilsonApp) : ViewModel() {
    val state = MutableStateFlow(SignInState())
    private var challengeId: String? = null
    private var factorId: String? = null

    init {
        viewModelScope.launch {
            val kept = app.settings.server.first()
            if (kept != null) state.update { it.copy(server = kept, step = SignInStep.PASSWORD) }
        }
    }

    private val server get() = ServerUrl.parse(state.value.server, allowCleartext = BuildConfig.DEBUG)

    fun edit(change: (SignInState) -> SignInState) = state.update { change(it).copy(error = null) }

    fun back() = state.update {
        it.copy(step = if (it.step == SignInStep.CODE) SignInStep.PASSWORD else SignInStep.SERVER, code = "", password = "", error = null)
    }

    private fun busy(block: suspend () -> Unit) {
        state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            block()
            state.update { it.copy(busy = false) }
        }
    }

    /** Asks the address to prove it is a Wilson before anything is typed at it. */
    fun checkServer() {
        val server = server ?: return state.update { it.copy(error = "That address does not look right.") }
        busy {
            val answered = runCatching { HttpClients.sdkFor(server, Patience.SHORT) { emptyMap() }.health.getHealth() }.isSuccess
            if (answered) {
                app.settings.saveServer(server.origin)
                state.update { it.copy(server = server.origin, step = SignInStep.PASSWORD) }
            } else {
                state.update { it.copy(error = "No Wilson answered at ${server.origin}.") }
            }
        }
    }

    fun signIn() {
        val server = server ?: return
        val typed = state.value
        busy { settle(app.session.signIn(server, typed.email.trim(), typed.password)) }
    }

    fun submitCode() {
        val server = server ?: return
        val typed = state.value
        val challenge = challengeId ?: return
        busy { settle(app.session.finishSignIn(server, typed.email.trim(), challenge, factorId, typed.code.trim())) }
    }

    private fun settle(result: SignInResult) {
        when (result) {
            SignInResult.Ok -> state.update { it.copy(password = "", code = "") }
            SignInResult.BadCredentials ->
                state.update {
                    it.copy(error = if (it.step == SignInStep.CODE) "That code is wrong or has expired." else "Wrong email or password.", code = "")
                }
            SignInResult.TooManyAttempts -> state.update { it.copy(error = "Too many attempts. Wait five minutes.") }
            SignInResult.PasskeyOnly ->
                state.update { it.copy(error = "This account only has passkeys, which this app cannot use. Set up an authenticator app in the web app.") }
            is SignInResult.CodeNeeded -> {
                challengeId = result.challengeId
                factorId = result.factors.singleOrNull()?.id
                state.update { it.copy(step = SignInStep.CODE, password = "") }
            }
            is SignInResult.Failed -> state.update { it.copy(error = "Could not reach the server.") }
        }
    }
}
