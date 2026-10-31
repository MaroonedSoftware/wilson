package com.maroonedsoftware.wilson.ui.edit

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.sdk.models.CreateCardRequest
import com.maroonedsoftware.wilson.sdk.models.EditCardRequest
import com.maroonedsoftware.wilson.sdk.models.RenameCardRequest
import com.maroonedsoftware.wilson.ui.card.reasonFor
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class CardFormState(
    val title: String = "",
    val body: String = "",
    val loaded: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
)

/** A new card when [id] is null, otherwise that card's title and body. */
class CardFormModel(private val app: WilsonApp, private val project: String, private val id: String?) : ViewModel() {
    val state = MutableStateFlow(CardFormState(loaded = id == null))

    /** Fires the card's id once it is saved. */
    val saved = MutableSharedFlow<String>(extraBufferCapacity = 1)
    private var original = CardFormState()

    init {
        if (id != null) {
            viewModelScope.launch {
                try {
                    val card = app.session.call(project) { it.board.getCard(id) }
                    original = CardFormState(title = card.title, body = card.body)
                    state.value = original.copy(loaded = true)
                } catch (error: Exception) {
                    state.update { it.copy(error = reasonFor(error)) }
                }
            }
        }
    }

    fun edit(change: (CardFormState) -> CardFormState) = state.update { change(it).copy(error = null) }

    fun save() {
        val typed = state.value
        if (typed.title.isBlank()) return state.update { it.copy(error = "A card needs a title.") }
        state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val savedId =
                    if (id == null) {
                        app.session.call(project) { it.board.createCard(CreateCardRequest(title = typed.title.trim(), body = typed.body)) }.id
                    } else {
                        // Each is its own guarded write, so an unchanged half is not sent to be refused.
                        if (typed.title != original.title) app.session.call(project) { it.board.renameCard(id, RenameCardRequest(typed.title.trim())) }
                        if (typed.body != original.body) app.session.call(project) { it.board.editCardBody(id, EditCardRequest(typed.body)) }
                        id
                    }
                saved.emit(savedId)
            } catch (error: Exception) {
                state.update { it.copy(busy = false, error = reasonFor(error)) }
            }
        }
    }
}
