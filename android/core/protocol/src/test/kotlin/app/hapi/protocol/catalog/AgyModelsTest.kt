package app.hapi.protocol.catalog

import app.hapi.protocol.wire.AgentModelEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AgyModelsTest {
    @Test
    fun `native variants split while custom names and thinking models stay intact`() {
        for (effort in listOf("low", "medium", "high", "xhigh", "max")) {
            assertEquals(AgyModelSelection("gemini-4-argon", effort), AgyModels.splitSelection("gemini-4-argon-$effort"))
        }
        assertEquals(AgyModelSelection("claude-opus-5-5", "high"), AgyModels.splitSelection(" claude-opus-5-5-high "))
        for (model in listOf("claude-opus-4-6-thinking", "custom-high", "provider/custom-low")) {
            assertEquals(AgyModelSelection(model, null), AgyModels.splitSelection(model))
        }
        for (model in listOf(null, "", "  ", "auto", "default")) {
            assertEquals(AgyModelSelection(null, null), AgyModels.splitSelection(model))
        }
    }

    @Test
    fun `catalog groups only adjustable families and preserves offered effort order`() {
        val choices = AgyModels.choices(listOf(
            AgentModelEntry("gemini-4-argon-high", "Gemini 4 Argon (High)"),
            AgentModelEntry("claude-opus-5-5-max", "Claude Opus 5.5 (Max)"),
            AgentModelEntry("gemini-4-argon-low", "Gemini 4 Argon (Low)"),
            AgentModelEntry("gemini-4-argon-high", "Gemini 4 Argon (High)"),
            AgentModelEntry("claude-opus-5-5-xhigh", "Claude Opus 5.5 (XHigh)"),
            AgentModelEntry("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
            AgentModelEntry("custom-high", "Custom (High)"),
        ))
        assertEquals(listOf(
            AgyModelChoice("gemini-4-argon", "Gemini 4 Argon", listOf("low", "high")),
            AgyModelChoice("claude-opus-5-5", "Claude Opus 5.5", listOf("xhigh", "max")),
            AgyModelChoice("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", emptyList()),
            AgyModelChoice("custom-high", "Custom (High)", emptyList()),
        ), choices)
        assertEquals(choices.first(), AgyModels.selectedChoice(choices, "gemini-4-argon-high"))
        assertEquals(choices[2], AgyModels.selectedChoice(choices, "gpt-oss-120b-medium"))
        assertNull(AgyModels.selectedChoice(choices, "removed-model"))
    }

    @Test
    fun `unlabelled and empty catalogs need no static model guesses`() {
        assertEquals(listOf(
            AgyModelChoice("gemini-4-argon", "gemini-4-argon", listOf("medium", "high")),
            AgyModelChoice("custom", "custom", emptyList()),
        ), AgyModels.choices(listOf(
            AgentModelEntry("gemini-4-argon-medium"), AgentModelEntry("gemini-4-argon-high"), AgentModelEntry("custom"),
        )))
        assertEquals(emptyList(), AgyModels.choices(emptyList()))
    }
}
