package app.hapi.companion.feature.chat

import app.hapi.protocol.catalog.ClaudeModels
import app.hapi.protocol.chat.LatestUsage
import app.hapi.protocol.wire.AgentModelEntry
import app.hapi.protocol.wire.ProviderModel
import java.util.Locale
import kotlin.math.roundToInt

enum class ContextUsageTone { Normal, Warning, Danger }

/** Same budget, rounding and thresholds as Web's modelConfig and StatusBar. */
data class ContextUsageUi(val used: Double, val window: Double?, val cacheRead: Double?) {
    val usedPercentage: Int? = window?.let { (used / it * 100).coerceIn(0.0, 100.0).roundToInt() }
    val remainingPercentage: Int? = usedPercentage?.let { 100 - it }
    val remaining: Double? = window?.let { (it - used).coerceAtLeast(0.0) }
    val tone: ContextUsageTone = when {
        window == null -> ContextUsageTone.Normal
        used / window >= 0.9 -> ContextUsageTone.Danger
        used / window >= 0.7 -> ContextUsageTone.Warning
        else -> ContextUsageTone.Normal
    }
}

internal fun contextUsage(
    usage: LatestUsage?,
    flavor: String?,
    model: String?,
    piModels: List<AgentModelEntry> = emptyList(),
    piSelectedModel: ProviderModel? = null,
): ContextUsageUi? {
    if (usage == null || !usage.contextSize.isFinite()) return null
    val piWindow = if (flavor == "pi" && !model.isNullOrEmpty()) {
        piModels.firstOrNull { candidate ->
            if (piSelectedModel != null) {
                candidate.provider == piSelectedModel.provider && candidate.modelId == piSelectedModel.modelId
            } else candidate.modelId == model
        }?.contextWindow
    } else null
    val window = usage.contextWindow.positiveFinite()
        ?: piWindow.positiveFinite()
        ?: contextBudgetTokens(usage.model ?: model, flavor)
    return ContextUsageUi(usage.contextSize.coerceAtLeast(0.0), window, usage.cacheRead.positiveFinite())
}

private fun Double?.positiveFinite(): Double? = this?.takeIf { it.isFinite() && it > 0 }

/** Only heuristics reserve 10k headroom; reported limits and Pi catalog limits are exact. */
internal fun contextBudgetTokens(model: String?, flavor: String?): Double? {
    val trimmed = model?.trim().orEmpty()
    val window = when (flavor) {
        "codex" -> 258_400.0
        "pi" -> 200_000.0
        "cursor" -> cursorContextWindow(trimmed) ?: return null
        "claude" -> when {
            trimmed.isEmpty() -> 200_000.0
            trimmed in ClaudeModels.PRESETS || trimmed.startsWith("claude-") -> {
                if (trimmed.endsWith("[1m]") || trimmed == "fable" || trimmed.startsWith("claude-fable")) 1_000_000.0
                else 200_000.0
            }
            else -> return null
        }
        else -> return null
    }
    return (window - 10_000).coerceAtLeast(1.0)
}

private fun cursorContextWindow(model: String): Double? {
    val parameters = Regex("\\[([^]]+)\\]").find(model)?.groupValues?.get(1) ?: return null
    for (segment in parameters.split(',')) {
        val parts = segment.split('=', limit = 2)
        if (parts.size != 2 || parts[0].trim() != "context") continue
        val raw = parts[1].trim().lowercase(Locale.ROOT)
        val value = Regex("\\d+").find(raw)?.value?.toDoubleOrNull() ?: return null
        return (if (raw.endsWith('k')) value * 1000 else value).positiveFinite()
    }
    return null
}

internal fun formatContextTokens(value: Double): String = when {
    value >= 1_000_000 -> String.format(Locale.ROOT, "%.1fM", value / 1_000_000)
    value >= 1_000 -> "${Math.round(value / 1_000)}k"
    value == value.toLong().toDouble() -> value.toLong().toString()
    else -> value.toString()
}
