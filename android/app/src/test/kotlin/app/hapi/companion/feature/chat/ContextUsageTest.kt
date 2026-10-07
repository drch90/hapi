package app.hapi.companion.feature.chat

import app.hapi.protocol.chat.LatestUsage
import app.hapi.protocol.wire.AgentModelEntry
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.ProviderModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class ContextUsageTest {
    private fun usage(size: Double = 90_000.0, window: Double? = null, model: String? = null, cache: Double = 86_000.0) =
        LatestUsage(4_000.0, 20.0, 0.0, cache, size, window, model, 1L)

    @Test fun `reported context window takes precedence without subtracting headroom`() {
        val result = assertNotNull(contextUsage(usage(window = 258_000.0), "codex", "gpt-5.4"))
        assertEquals(258_000.0, result.window)
        assertEquals(35, result.usedPercentage)
        assertEquals(65, result.remainingPercentage)
        assertEquals(168_000.0, result.remaining)
        assertEquals(86_000.0, result.cacheRead)
    }

    @Test fun `fallback budgets match Web including local Claude message models`() {
        assertEquals(190_000.0, contextBudgetTokens(null, "claude"))
        assertEquals(190_000.0, contextBudgetTokens("claude-sonnet-4-6", "claude"))
        for (model in listOf("sonnet[1m]", "claude-opus-4-8[1m]", "fable", "fable[1m]", "claude-fable-5")) {
            assertEquals(990_000.0, contextBudgetTokens(model, "claude"), model)
        }
        assertEquals(248_400.0, contextBudgetTokens("gpt-5.4", "codex"))
        assertEquals(190_000.0, contextBudgetTokens(null, "pi"))
        assertEquals(990_000.0, contextUsage(usage(model = "claude-fable-5"), "claude", "sonnet")?.window)
        assertNull(contextBudgetTokens("custom-model", "claude"))
        assertNull(contextBudgetTokens("gemini-3-pro", "gemini"))
    }

    @Test fun `Cursor parses wire context parameters and leaves unknown limits unset`() {
        assertEquals(290_000.0, contextBudgetTokens("composer-2.5-fast[context=300k]", "cursor"))
        assertEquals(190_000.0, contextBudgetTokens("model[reasoning=high, context=200000]", "cursor"))
        assertEquals(1.0, contextBudgetTokens("model[context=8K]", "cursor"))
        for (model in listOf("auto", "model[context=unknown]", "model[context=0]")) {
            assertNull(contextBudgetTokens(model, "cursor"))
        }
    }

    @Test fun `Pi catalog uses provider identity and reported usage still wins`() {
        val models = listOf(
            AgentModelEntry("shared", provider = "a", contextWindow = 100_000.0),
            AgentModelEntry("shared", provider = "b", contextWindow = 200_000.0),
        )
        assertEquals(200_000.0, contextUsage(usage(), "pi", "shared", models, ProviderModel("b", "shared"))?.window)
        assertEquals(100_000.0, contextUsage(usage(), "pi", "shared", models)?.window)
        assertEquals(190_000.0, contextUsage(usage(), "pi", "shared", models, ProviderModel("missing", "shared"))?.window)
        assertEquals(80_000.0, contextUsage(usage(window = 80_000.0), "pi", "shared", models, ProviderModel("b", "shared"))?.window)
        val decoded = HapiJson.decodeFromString(AgentModelEntry.serializer(), """{"provider":"b","modelId":"shared","contextWindow":200000}""")
        assertEquals(200_000.0, decoded.contextWindow)
    }

    @Test fun `percentages stay complementary and bounded but warnings use unrounded usage`() {
        val midpoint = ContextUsageUi(69.0, 200.0, null)
        assertEquals(35, midpoint.usedPercentage)
        assertEquals(65, midpoint.remainingPercentage)
        val over = ContextUsageUi(300.0, 200.0, null)
        assertEquals(100, over.usedPercentage)
        assertEquals(0, over.remainingPercentage)
        assertEquals(0.0, over.remaining)
        assertEquals(ContextUsageTone.Normal, ContextUsageUi(69.9, 100.0, null).tone)
        assertEquals(ContextUsageTone.Warning, ContextUsageUi(70.0, 100.0, null).tone)
        assertEquals(ContextUsageTone.Warning, ContextUsageUi(89.9, 100.0, null).tone)
        assertEquals(ContextUsageTone.Danger, ContextUsageUi(90.0, 100.0, null).tone)
    }

    @Test fun `no usage is hidden and unknown limits have no percentage or remaining estimate`() {
        assertNull(contextUsage(null, "codex", null))
        assertNull(contextUsage(usage(size = Double.NaN), "codex", null))
        val unknown = assertNotNull(contextUsage(usage(size = 0.0, cache = 0.0), "gemini", null))
        assertEquals(0.0, unknown.used)
        assertNull(unknown.window)
        assertNull(unknown.usedPercentage)
        assertNull(unknown.remaining)
        assertNull(unknown.cacheRead)
        assertNull(contextUsage(usage(window = 0.0), "gemini", null)?.window)
    }

    @Test fun `token formatting matches the compact Web labels`() {
        assertEquals("0", formatContextTokens(0.0))
        assertEquals("999", formatContextTokens(999.0))
        assertEquals("2k", formatContextTokens(1_500.0))
        assertEquals("258k", formatContextTokens(258_400.0))
        assertEquals("1.0M", formatContextTokens(1_000_000.0))
        assertEquals("1.3M", formatContextTokens(1_250_000.0))
    }
}
