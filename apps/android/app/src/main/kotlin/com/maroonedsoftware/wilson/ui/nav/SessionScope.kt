package com.maroonedsoftware.wilson.ui.nav

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner

/**
 * Where the signed-in screens keep their view models, so none outlives the session it read from.
 *
 * Nothing scopes a view model to a navigation entry here, so without this they all sit in the
 * activity's store and survive signing out: the board then showed the projects, or the error, of
 * the server signed out of. This is itself held by the activity, so a rotation keeps them, and
 * [end] empties it when the session ends.
 */
class SessionScope : ViewModel(), ViewModelStoreOwner {
    override val viewModelStore = ViewModelStore()

    /** The session ended: every signed-in screen's model goes, and the next sign-in starts afresh. */
    fun end() = viewModelStore.clear()

    override fun onCleared() = viewModelStore.clear()
}
