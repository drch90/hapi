package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.feature.chat.blocks.GeneratedImageBlockView
import app.hapi.companion.feature.chat.blocks.UserTextBlockView
import app.hapi.companion.feature.chat.media.ChatImageGallery
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.*
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test

class ChatMediaCardsTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun block(id: String, mime: String) = GeneratedImageBlock(id, null, 0, null, id, "$id.file", mime, null, null)

    @Test fun audioVideoAndFilesWaitForExplicitDownload() {
        val fetches = AtomicInteger()
        val media = ChatMedia(null, downloadMedia = { _, _ -> fetches.incrementAndGet(); Unit }) { null }
        compose.setContent {
            HapiTheme { CompositionLocalProvider(LocalChatMedia provides media) {
                Column {
                    GeneratedImageBlockView(block("video", "video/mp4"))
                    GeneratedImageBlockView(block("audio", "audio/wav"))
                    GeneratedImageBlockView(block("document", "application/pdf"))
                }
            } }
        }
        compose.onNodeWithText(context.getString(R.string.chat_media_load_video)).assertExists()
        compose.onNodeWithText(context.getString(R.string.chat_media_load_audio)).assertExists()
        compose.onNodeWithText(context.getString(R.string.chat_media_prepare_download)).assertExists()
        compose.runOnIdle { assertEquals(0, fetches.get()) }
    }

    @Test fun failedFileTransferCanRetryAndThenSave() {
        val fetches = AtomicInteger()
        val media = ChatMedia(null, downloadMedia = { _, target ->
            if (fetches.incrementAndGet() == 1) throw java.io.IOException("Offline")
            target.writeText("downloaded contents")
        }) { null }
        compose.setContent { HapiTheme { CompositionLocalProvider(LocalChatMedia provides media) {
            GeneratedImageBlockView(block("report", "application/pdf"))
        } } }
        compose.onNodeWithText(context.getString(R.string.chat_media_prepare_download)).performClick()
        compose.waitUntil(5_000) { fetches.get() == 1 }
        compose.onNodeWithText(context.getString(R.string.chat_media_retry)).performClick()
        compose.waitUntil(5_000) { fetches.get() == 2 }
        compose.onNodeWithText(context.getString(R.string.chat_media_save)).assertExists()
    }

    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    @Test fun audioPreparesWithoutAutoplayAndStopsWhenCardIsRemoved() {
        // Three seconds of silent PCM: tests real decoding without an external asset or network.
        val samples = 8_000 * 3
        val wav = java.nio.ByteBuffer.allocate(44 + samples * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(36 + samples * 2); put("WAVEfmt ".toByteArray())
            putInt(16); putShort(1.toShort()); putShort(1.toShort()); putInt(8_000); putInt(16_000)
            putShort(2.toShort()); putShort(16.toShort()); put("data".toByteArray()); putInt(samples * 2)
        }.array()
        val shown = mutableStateOf(true)
        val media = ChatMedia(null, downloadMedia = { _, target -> target.writeBytes(wav) }) { null }
        compose.setContent { HapiTheme { CompositionLocalProvider(LocalChatMedia provides media) {
            if (shown.value) GeneratedImageBlockView(block("audio", "audio/wav"))
        } } }
        compose.onNodeWithText(context.getString(R.string.chat_media_load_audio)).performClick()
        var player: androidx.media3.common.Player? = null
        fun findPlayer(view: android.view.View): androidx.media3.common.Player? {
            if (view is androidx.media3.ui.PlayerView) return view.player
            if (view is android.view.ViewGroup) for (i in 0 until view.childCount) {
                findPlayer(view.getChildAt(i))?.let { return it }
            }
            return null
        }
        compose.waitUntil(10_000) {
            var ready = false
            compose.runOnIdle {
                val activities = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                    .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED)
                player = activities.firstNotNullOfOrNull { findPlayer(it.window.decorView) }
                ready = player?.playbackState == androidx.media3.common.Player.STATE_READY
            }
            ready
        }
        compose.runOnIdle { assertFalse(player!!.playWhenReady); player!!.play() }
        compose.waitUntil(5_000) {
            var playing = false
            compose.runOnIdle { playing = player!!.isPlaying }
            playing
        }
        compose.runOnIdle { shown.value = false }
        compose.runOnIdle { assertFalse(player!!.isPlaying) }
    }

    @Test fun attachmentImagesOpenGalleryZoomAndMoveToAnotherImage() {
        val bitmap = android.graphics.Bitmap.createBitmap(8, 8, android.graphics.Bitmap.Config.ARGB_8888)
        val bytes = java.io.ByteArrayOutputStream().use { output ->
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output)
            output.toByteArray()
        }
        bitmap.recycle()
        val preview = "data:image/png;base64," + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        val user = UserTextBlock("user", null, 0, null, "Images", listOf(
            ChatAttachment("one", "first.png", "image/png", 100.0, "one", preview),
            ChatAttachment("two", "second.png", "image/png", 100.0, "two", preview),
        ), null, null, null)
        val media = ChatMedia(null) { null }
        compose.setContent { HapiTheme { ChatImageGallery(listOf(user), media) { UserTextBlockView(user) } } }
        compose.waitUntil(5_000) { compose.onAllNodesWithContentDescription("first.png").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("first.png").performClick()
        compose.onNodeWithText("1 / 2").assertExists()
        compose.onNodeWithText("+").performClick()
        compose.onNodeWithText("150%").assertExists()
        compose.onNodeWithText(context.getString(R.string.chat_media_next)).performClick()
        compose.onNodeWithText("2 / 2").assertExists()
        compose.onNodeWithText("100%").assertExists()
        compose.onNodeWithText(context.getString(R.string.chat_media_close)).performClick()
        compose.onNodeWithText("2 / 2").assertDoesNotExist()
    }
}
