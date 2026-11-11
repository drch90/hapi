package app.hapi.protocol.catalog

import app.hapi.protocol.wire.AgentModelEntry

data class AgyModelChoice(val modelId: String, val name: String, val supportedEfforts: List<String>)
data class AgyModelSelection(val model: String?, val effort: String?)

/** Antigravity's native model variants, matching `shared/src/agyModels.ts`. */
object AgyModels {
    val EFFORT_LEVELS = listOf("low", "medium", "high", "xhigh", "max")
    private val variant = Regex("^(gemini-.+|claude-.+|gpt-oss-.+)-(low|medium|high|xhigh|max)$")

    fun splitSelection(model: String?): AgyModelSelection {
        val value = model?.trim()
        if (value.isNullOrEmpty() || value == "auto" || value == "default") return AgyModelSelection(null, null)
        val match = variant.matchEntire(value) ?: return AgyModelSelection(value, null)
        return AgyModelSelection(match.groupValues[1], match.groupValues[2])
    }

    fun choices(catalog: List<AgentModelEntry>): List<AgyModelChoice> {
        val effortsByModel = mutableMapOf<String, MutableSet<String>>()
        for (entry in catalog) {
            val (model, effort) = splitSelection(entry.modelId)
            if (model != null && effort != null) effortsByModel.getOrPut(model) { mutableSetOf() }.add(effort)
        }
        val choices = linkedMapOf<String, AgyModelChoice>()
        for (entry in catalog) {
            val (model, effort) = splitSelection(entry.modelId)
            if (model == null) continue
            val efforts = effortsByModel[model].orEmpty()
            // A single variant does not establish adjustable effort.
            val adjustable = efforts.size > 1
            val modelId = if (adjustable) model else entry.modelId
            if (modelId in choices) continue
            val name = if (adjustable && effort != null) {
                entry.name?.replace(Regex("\\s*\\($effort\\)$", RegexOption.IGNORE_CASE), "") ?: model
            } else entry.name ?: entry.modelId
            choices[modelId] = AgyModelChoice(modelId, name, if (adjustable) EFFORT_LEVELS.filter { it in efforts } else emptyList())
        }
        return choices.values.toList()
    }

    fun selectedChoice(choices: List<AgyModelChoice>, model: String?): AgyModelChoice? =
        choices.firstOrNull { it.modelId == model }
            ?: choices.firstOrNull { it.modelId == splitSelection(model).model }
}
