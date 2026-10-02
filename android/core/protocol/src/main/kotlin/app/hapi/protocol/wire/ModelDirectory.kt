package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

/** Common fields of the agent-specific model directory responses, with typed Pi/Cursor details. */
@Serializable
data class AgentModelDirectory(
    val success: Boolean,
    val availableModels: List<AgentModelEntry> = emptyList(),
    val cliModelSkus: List<AgentModelEntry> = emptyList(),
    val currentModelId: String? = null,
    val parameterized: Boolean = false,
    val autoPermissionModeSupported: Boolean? = null,
    val error: String? = null,
)

@Serializable
data class AgentModelEntry(
    val modelId: String,
    val name: String? = null,
    val provider: String? = null,
    val reasoning: Boolean? = null,
    val thinkingLevelMap: Map<String, String?>? = null,
    val reasoningEfforts: List<AgentEffortOption> = emptyList(),
) {
    // An opaque UI identity, not an endpoint model id. JSON preserves provider boundaries.
    val selectionKey: String get() = provider?.let { HapiJson.encodeToString(ProviderModel.serializer(), ProviderModel(it, modelId)) } ?: modelId
}

@Serializable
data class ProviderModel(val provider: String, val modelId: String)

@Serializable
data class AgentEffortOption(val value: String, val name: String? = null, val isDefault: Boolean? = null)

@Serializable
data class AgentEffortDirectory(
    val success: Boolean,
    val options: List<AgentEffortOption> = emptyList(),
    val currentValue: String? = null,
    val currentModelId: String? = null,
    val targetModelId: String? = null,
    val error: String? = null,
)
