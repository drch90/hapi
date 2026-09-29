package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
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
