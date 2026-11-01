package com.maroonedsoftware.wilson.push

/** The ids a push carries (`fcm.channel.ts`). A title never travels through Google. */
data class PushMessage(val moment: String, val project: String, val cardId: String) {
    /** A separate channel per kind of moment, so each can be silenced on its own. */
    val channel: PushChannel
        get() =
            when (moment) {
                "manual" -> PushChannel.GATES
                "source-closed" -> PushChannel.UPDATES
                else -> PushChannel.NEEDS_YOU
            }

    /** What the notification says. Used bare when the title could not be fetched. */
    fun headline(): String =
        when (moment) {
            "manual" -> "Card $cardId is waiting at a gate"
            "needs-human" -> "Card $cardId needs you"
            "poisoned" -> "Card $cardId was poisoned"
            "source-closed" -> "Card $cardId's ticket closed"
            else -> "Card $cardId needs a look"
        }

    companion object {
        fun from(data: Map<String, String>): PushMessage? {
            val moment = data["moment"] ?: return null
            val project = data["project"] ?: return null
            val cardId = data["cardId"] ?: return null
            return PushMessage(moment, project, cardId)
        }
    }
}

enum class PushChannel(val id: String, val label: String) {
    NEEDS_YOU("needs-you", "Cards that need you"),
    GATES("gates", "Cards waiting at a gate"),
    UPDATES("updates", "Card updates"),
}
