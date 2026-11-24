package app.hapi.companion.feature.chat

import app.hapi.protocol.chat.UserTextBlock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class ConversationOutlineTest {
    @Test fun `only invoked and failed messages are locatable with transcript keys`() {
        fun row(id: String, invoked: Long?, status: String?) = UserTextBlock(
            "user-text:$id", null, 1L, invoked, "  标题\n 内容 ", null, status, null, null,
        )
        val outline = conversationOutline(listOf(row("sent", 2, "sent"), row("pending", null, "queued"), row("failed", null, "failed")))
        assertEquals(listOf("user-text:sent", "user-text:failed"), outline.map { it.id })
        assertEquals(listOf("标题 内容", "标题 内容"), outline.map { it.label })
    }

    @Test fun translatedMessagesUseTheOriginalPromptInTheOutline() {
        val row = UserTextBlock("user-text:translated", null, 1, 2, "Review this change", null, "sent", null,
            JsonObject(mapOf("translatedFrom" to JsonPrimitive(" 检查\n这次修改 "))))
        assertEquals("检查 这次修改", conversationOutline(listOf(row)).single().label)
    }
}
