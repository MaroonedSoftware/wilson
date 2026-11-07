package com.maroonedsoftware.wilson.ui.chat

import com.maroonedsoftware.wilson.auth.SessionManager
import com.maroonedsoftware.wilson.sdk.clients.FetchAChatImageResponse
import com.maroonedsoftware.wilson.sdk.models.ChatAttachment
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/*
 * How the chat draws a message's images.
 *
 * Web fetches `GET /api/chat/threads/{id}/attachments/{attachmentId}` through the SDK, because the route
 * needs the bearer and a plain `<img src>` would go out without it, and caches the bytes for good with no
 * retry: attachments are content-hashed and never rewritten. Android does the same through
 * `SessionManager.call`, so a 401 meets the one single-flight refresh every other call shares, and keeps
 * what came back in memory for as long as the chat's ViewModel lives. Ktor is all it takes, and decoding
 * is `BitmapFactory`, so no image library is added: the cache is a map, there is no disk to manage, and
 * an image library would bring its own HTTP stack that knows nothing of the session.
 */

/** Where one image stands. [T] is the decoded image, kept out of here so this runs on a plain JVM. */
sealed interface ImageLoad<out T> {
    data object Loading : ImageLoad<Nothing>

    data class Loaded<T>(val image: T) : ImageLoad<T>

    /** The fetch failed, or the bytes were not an image this phone can draw (an SVG, say). */
    data object Failed : ImageLoad<Nothing>
}

/**
 * Each image of a chat, fetched once and held for the life of [scope]. Asking again for one already
 * asked for answers with the same state, so scrolling it off and back neither refetches nor redecodes.
 * A failure is kept, as web keeps it: the bytes behind an id never change, so asking again would only
 * fail again.
 */
class ChatImages<T>(
    private val scope: CoroutineScope,
    private val fetch: suspend (threadId: String, attachmentId: String) -> ByteArray,
    private val decode: suspend (ByteArray) -> T?,
) {
    private val loads = ConcurrentHashMap<String, StateFlow<ImageLoad<T>>>()

    fun load(threadId: String, attachmentId: String): StateFlow<ImageLoad<T>> =
        loads.computeIfAbsent("$threadId/$attachmentId") {
            val state = MutableStateFlow<ImageLoad<T>>(ImageLoad.Loading)
            scope.launch {
                state.value =
                    try {
                        decode(fetch(threadId, attachmentId))?.let { ImageLoad.Loaded(it) } ?: ImageLoad.Failed
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        ImageLoad.Failed
                    }
            }
            state.asStateFlow()
        }
}

/** An image's bytes, through the signed-in session: its bearer, and on a 401 the one shared refresh. */
suspend fun fetchChatImage(session: SessionManager, threadId: String, attachmentId: String): ByteArray =
    session.call { it.chat.fetchAChatImage(threadId, attachmentId) }.bytes()

internal fun FetchAChatImageResponse.bytes(): ByteArray = when (this) {
    is FetchAChatImageResponse.ImagePng -> data
    is FetchAChatImageResponse.ImageJpeg -> data
    is FetchAChatImageResponse.ImageWebp -> data
    is FetchAChatImageResponse.ImageGif -> data
    is FetchAChatImageResponse.ImageSvgXml -> data
}

/**
 * What one image says for itself: read out in place of it, and shown in its place when it cannot load.
 * The count the bubble used to say is kept in it, so a screen reader still hears how many there are.
 */
internal fun imageCaption(index: Int, count: Int, attachment: ChatAttachment): String =
    if (count == 1) "Image: ${attachment.filename}" else "Image ${index + 1} of $count: ${attachment.filename}"

/**
 * The power of two to shrink an image by on decoding so neither side exceeds [longest]. A camera photo
 * at full size is tens of megabytes as a bitmap, and a bitmap too big for the canvas crashes the draw.
 */
internal fun sampleSize(width: Int, height: Int, longest: Int): Int {
    var sample = 1
    while (width / sample > longest || height / sample > longest) sample *= 2
    return sample
}
