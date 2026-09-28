package app.hapi.companion.feature.chat

import app.hapi.protocol.chat.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

internal fun messageTimestamp(value: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
        .withZone(zone).format(Instant.ofEpochMilli(value))

/** Immutable export input: streaming mutations cannot change an in-flight image. */
internal data class ShareMessage(
    val id: String,
    val timestamp: Long,
    val user: Boolean,
    val text: String,
    val filenames: List<String>,
)

internal fun shareMessage(block: VisibleChatBlock): ShareMessage? = when (block) {
    is UserTextBlock -> ShareMessage(block.id, block.createdAt, true, block.text,
        block.attachments.orEmpty().map { it.filename })
    is AgentTextBlock -> ShareMessage(block.id, block.createdAt, false, block.text, emptyList())
    else -> null
}

internal data class ToolTiming(val start: Long?, val end: Long?, val elapsed: Long?)

internal fun toolTiming(tool: ChatToolCall, now: Long): ToolTiming {
    if (tool.state == ToolState.PENDING) return ToolTiming(null, null, null)
    val running = tool.state == ToolState.RUNNING
    val execPair = !running && tool.execStartedAt?.isFinite() == true && tool.execCompletedAt?.isFinite() == true
    val start = if (execPair) tool.execStartedAt!!.toLong()
        else tool.startedAt?.takeIf { it.isFinite() }?.toLong() ?: tool.createdAt
    val end = if (running) null else (if (execPair) tool.execCompletedAt else tool.completedAt)
        ?.takeIf { it.isFinite() }?.toLong()
    val elapsed = (if (running) (now - start).coerceAtLeast(0) else end?.minus(start))?.takeIf { it >= 0 }
    return ToolTiming(start, end, elapsed)
}

internal fun elapsedTime(ms: Long): String {
    if (ms < 1000) return "$ms ms"
    val seconds = ms / 1000
    return if (seconds >= 3600) String.format(Locale.ROOT, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
        else String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60)
}

/** Merge newly loaded rows around known anchors without using selection order. */
internal fun mergeShareOrder(previous: List<String>, visible: List<String>): List<String> {
    val known = previous.toHashSet()
    val before = mutableMapOf<String, List<String>>()
    var pending = mutableListOf<String>()
    for (id in visible) {
        if (id in known) {
            if (pending.isNotEmpty()) before[id] = pending
            pending = mutableListOf()
        } else {
            pending.add(id)
        }
    }
    return buildList {
        for (id in previous) {
            addAll(before[id].orEmpty())
            add(id)
        }
        addAll(pending)
    }
}
