package app.hapi.companion.feature.chat

import app.hapi.protocol.chat.*
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MessagePresentationTest {
    private fun tool(state: String = ToolState.COMPLETED) = ChatToolCall(
        id = "tool", name = "Bash", state = state, input = null, description = null,
        createdAt = 1000, startedAt = 2000.0, completedAt = 6000.0,
        execStartedAt = 3000.0, execCompletedAt = 5000.0,
    )

    @Test fun selectionOrderSurvivesPrependingEvictionAndStreaming() {
        val initial = mergeShareOrder(emptyList(), listOf("b", "c"))
        val prepended = mergeShareOrder(initial, listOf("a", "b", "c"))
        val evicted = mergeShareOrder(prepended, listOf("c", "d"))
        assertEquals(listOf("a", "b", "c", "d"), evicted)
        assertEquals(evicted, mergeShareOrder(evicted, listOf("c", "d")))
        val selected = setOf("d", "a")
        assertEquals(listOf("a", "d"), evicted.filter { it in selected })
    }

    @Test fun executionPairWinsOnlyAfterCompletion() {
        assertEquals(ToolTiming(3000, 5000, 2000), toolTiming(tool(), 9000))
        assertEquals(ToolTiming(2000, null, 7000), toolTiming(tool(ToolState.RUNNING), 9000))
        assertEquals(ToolTiming(null, null, null), toolTiming(tool(ToolState.PENDING), 9000))
        assertEquals(ToolTiming(3000, 5000, 2000), toolTiming(tool(ToolState.ERROR), 9000))
    }

    @Test fun missingExecutionEndpointNeverMixesClocks() {
        assertEquals(ToolTiming(2000, 6000, 4000), toolTiming(tool().copy(execCompletedAt = null), 9000))
        assertEquals(ToolTiming(1000, 6000, 5000), toolTiming(tool().copy(startedAt = null, execStartedAt = null), 9000))
        assertNull(toolTiming(tool().copy(execCompletedAt = 2500.0), 9000).elapsed)
        assertNull(toolTiming(tool().copy(execStartedAt = null, completedAt = null), 9000).elapsed)
        assertEquals(0L, toolTiming(tool(ToolState.RUNNING), 500).elapsed)
    }

    @Test fun timestampsHaveDatesSecondsAndExplicitDeviceZone() {
        assertEquals("1970-01-01 00:00:00", messageTimestamp(0, ZoneId.of("UTC")))
        assertEquals("1970-01-01 08:00:00", messageTimestamp(0, ZoneId.of("Asia/Shanghai")))
        assertEquals("1:01:01", elapsedTime(3661000))
        assertEquals("0:01", elapsedTime(1999))
    }

    @Test fun exportSnapshotsRetainFullTextAndExcludeNonMessages() {
        val body = "```kotlin\nval 中文 = 1\n```\n".repeat(1000)
        val block = AgentTextBlock("reply", null, 1234, null, text = body, meta = null)
        val snapshot = shareMessage(block)!!
        block.text = "next streamed revision"
        assertEquals(body, snapshot.text)
        assertEquals(1234L, snapshot.timestamp)
        val user = UserTextBlock("user", null, 5678, null, "hello", listOf(
            ChatAttachment("file", "photo.png", "image/png", 1.0, "/private/path", "data:image/png;base64,test"),
        ), null, null, null)
        assertEquals(listOf("photo.png"), shareMessage(user)!!.filenames)
        assertNull(shareMessage(ToolCallBlock("tool", null, 1, null, tool = tool(), children = emptyList(), meta = null)))
    }
}
