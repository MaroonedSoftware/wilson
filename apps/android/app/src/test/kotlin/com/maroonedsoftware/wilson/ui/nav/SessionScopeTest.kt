package com.maroonedsoftware.wilson.ui.nav

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.CreationExtras
import kotlin.reflect.KClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Test

class SessionScopeTest {
    private class Screen : ViewModel() {
        var cleared = false

        init {
            addCloseable { cleared = true }
        }
    }

    private val factory =
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: KClass<T>, extras: CreationExtras): T = Screen() as T
        }

    private fun screenIn(scope: SessionScope) = ViewModelProvider.create(scope, factory)[Screen::class]

    @Test
    fun endingTheSessionClearsItsScreens() {
        val scope = SessionScope()
        val before = screenIn(scope)

        scope.end()

        assertEquals(true, before.cleared)
        assertNotSame(before, screenIn(scope))
    }

    @Test
    fun aScreenLastsWhileTheSessionDoes() {
        val scope = SessionScope()

        assertEquals(screenIn(scope), screenIn(scope))
    }
}
