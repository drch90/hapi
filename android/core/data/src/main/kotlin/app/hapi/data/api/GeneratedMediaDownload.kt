package app.hapi.data.api

import java.io.File
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response

/** No byte-array buffering; cancellation closes the socket and removes partial output. */
internal suspend fun Call.downloadTo(destination: File): Unit = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            destination.delete()
            continuation.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            try {
                response.use {
                    if (!it.isSuccessful) throw ApiError.from(it.code, it.body?.string().orEmpty())
                    val body = it.body ?: throw IOException("Empty media response")
                    body.byteStream().use { input ->
                        destination.outputStream().use { output ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                if (!continuation.isActive) throw IOException("Download cancelled")
                                val count = input.read(buffer)
                                if (count < 0) break
                                output.write(buffer, 0, count)
                            }
                        }
                    }
                }
                // If cancellation wins before dispatching to the caller, the
                // caller never owns the file, so release it here as well.
                continuation.resume(Unit, onCancellation = { _, _, _ -> destination.delete() })
            } catch (error: Exception) {
                destination.delete()
                continuation.resumeWithException(error)
            }
        }
    })
}
