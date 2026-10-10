package app.hapi.companion.feature.chat.composer

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.AgentStatusUi
import app.hapi.companion.feature.chat.ContextUsageUi

/** Status and context stay beside each other when space permits, wrapping at large font sizes. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AgentStatusBar(status: AgentStatusUi?, usage: ContextUsageUi?) {
    if (status == null && usage == null) return
    FlowRow(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        status?.let { AgentStatusIndicator(it, Modifier.align(Alignment.CenterVertically)) }
        usage?.let { ContextUsageIndicator(it, Modifier.align(Alignment.CenterVertically)) }
    }
}

@Composable
private fun AgentStatusIndicator(status: AgentStatusUi, modifier: Modifier = Modifier) {
    val (label, color) = when (status) {
        AgentStatusUi.Offline -> stringResource(R.string.chat_agent_offline) to Color(0xFF999999)
        AgentStatusUi.PermissionRequired -> stringResource(R.string.chat_agent_permission_required) to Color(0xFFFF9500)
        AgentStatusUi.Thinking -> stringResource(R.string.chat_agent_thinking) to Color(0xFF007AFF)
        is AgentStatusUi.BackgroundTasks -> stringResource(
            if (status.count == 1) R.string.chat_agent_background_one else R.string.chat_agent_background_many,
            status.count,
        ) to Color(0xFF007AFF)
        AgentStatusUi.Online -> stringResource(R.string.chat_agent_online) to Color(0xFF34C759)
    }
    val pulse = if (status != AgentStatusUi.Offline && status != AgentStatusUi.Online) {
        rememberInfiniteTransition(label = "agent-status").animateFloat(
            initialValue = 1f,
            targetValue = 0.5f,
            animationSpec = infiniteRepeatable(tween(1_000), RepeatMode.Reverse),
            label = "agent-status-dot",
        )
    } else null
    Row(
        modifier = modifier.padding(horizontal = 4.dp, vertical = 6.dp)
            .testTag("chat-agent-status")
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(8.dp).graphicsLayer { alpha = pulse?.value ?: 1f }.background(color, CircleShape))
        Text(label, style = MaterialTheme.typography.labelSmall, color = color)
    }
}
