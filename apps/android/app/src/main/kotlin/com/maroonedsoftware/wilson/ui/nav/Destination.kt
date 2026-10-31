package com.maroonedsoftware.wilson.ui.nav

import androidx.navigation3.runtime.NavKey
import androidx.savedstate.serialization.SavedStateConfiguration
import kotlinx.serialization.Serializable
import kotlinx.serialization.modules.SerializersModule
import kotlinx.serialization.modules.polymorphic
import kotlinx.serialization.modules.subclass

sealed interface Destination : NavKey {
    @Serializable
    data object Board : Destination

    @Serializable
    data class Card(val project: String, val id: String) : Destination

    @Serializable
    data class NewCard(val project: String) : Destination

    @Serializable
    data class EditCard(val project: String, val id: String) : Destination

    @Serializable
    data class Plan(val project: String, val id: String) : Destination
}

/** Every destination must be named here: the stack saves as `NavKey`, and an unnamed subclass fails to restore. */
val NavConfiguration = SavedStateConfiguration {
    serializersModule = SerializersModule {
        polymorphic(NavKey::class) {
            subclass(Destination.Board::class, Destination.Board.serializer())
            subclass(Destination.Card::class, Destination.Card.serializer())
            subclass(Destination.NewCard::class, Destination.NewCard.serializer())
            subclass(Destination.EditCard::class, Destination.EditCard.serializer())
            subclass(Destination.Plan::class, Destination.Plan.serializer())
        }
    }
}
