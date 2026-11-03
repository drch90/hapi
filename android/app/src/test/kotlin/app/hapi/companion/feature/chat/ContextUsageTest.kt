package app.hapi.companion.feature.chat

import app.hapi.protocol.chat.LatestUsage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import app.hapi.protocol.wire.AgentModelEntry
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.ProviderModel
import kotlin.test.assertNotNull

class ContextUsageTest {

    // ----------------------------------------------------- formatTokenCount --

    @Test fun tokenCountStaysPlainBelowOneThousand() {
        assertEquals("0", ContextUsage.formatTokenCount(0.0))
        assertEquals("86", ContextUsage.formatTokenCount(86.0))
        assertEquals("999", ContextUsage.formatTokenCount(999.0))
    }

    @Test fun tokenCountUsesWholeKFromOneThousand() {
        assertEquals("1k", ContextUsage.formatTokenCount(1_000.0))
        assertEquals("90k", ContextUsage.formatTokenCount(90_000.0))
        assertEquals("168k", ContextUsage.formatTokenCount(168_400.0))
        assertEquals("258k", ContextUsage.formatTokenCount(258_400.0))
        // Still the k branch right below 1M — rounding may reach 1000k.
        assertEquals("1000k", ContextUsage.formatTokenCount(999_999.0))
    }

    @Test fun tokenCountUsesOneDecimalMFromOneMillion() {
        assertEquals("1.0M", ContextUsage.formatTokenCount(1_000_000.0))
        assertEquals("1.1M", ContextUsage.formatTokenCount(1_050_000.0))
        assertEquals("2.5M", ContextUsage.formatTokenCount(2_500_000.0))
    }

    // -------------------------------------------------- contextPercentages --

    @Test fun percentagesRoundAndComplementToHundred() {
        assertEquals(35 to 65, ContextUsage.contextPercentages(90_000.0, 258_400.0))
        // Mid-point (34.5) rounds up; the complement comes off the same
        // rounded value so the pair never tears apart.
        assertEquals(35 to 65, ContextUsage.contextPercentages(69.0, 200.0))
        assertEquals(0 to 100, ContextUsage.contextPercentages(0.0, 190_000.0))
    }

    @Test fun percentagesClampWhenTheContextExceedsTheWindow() {
        assertEquals(100 to 0, ContextUsage.contextPercentages(300_000.0, 200_000.0))
    }

    // ----------------------------------------------------------- warning --

    @Test fun warningBandsFollowTheRawUsedRatio() {
        assertEquals(ContextUsageWarning.NORMAL, ContextUsage.warning(69_000.0, 100_000.0))
        // 69.999% is below the 70 threshold because the ratio is unrounded.
        assertEquals(ContextUsageWarning.NORMAL, ContextUsage.warning(69_999.0, 100_000.0))
        assertEquals(ContextUsageWarning.ELEVATED, ContextUsage.warning(70_000.0, 100_000.0))
        assertEquals(ContextUsageWarning.ELEVATED, ContextUsage.warning(89_000.0, 100_000.0))
        // 89.999% is still amber — only the raw 90% mark turns red.
        assertEquals(ContextUsageWarning.ELEVATED, ContextUsage.warning(89_999.0, 100_000.0))
        assertEquals(ContextUsageWarning.CRITICAL, ContextUsage.warning(90_000.0, 100_000.0))
        assertEquals(ContextUsageWarning.CRITICAL, ContextUsage.warning(95_000.0, 100_000.0))
        assertEquals(ContextUsageWarning.CRITICAL, ContextUsage.warning(200_000.0, 100_000.0))
    }

    // ----------------------------------------------------------- details --

    @Test fun detailsWithAKnownWindowCarryEveryField() {
        val d = ContextUsage.details(contextSize = 90_000.0, maxContextSize = 258_000.0, contextCacheRead = 86_000.0)
        assertEquals("86k", d.cacheRead)
        assertEquals("90k", d.used)
        assertEquals(35, d.usedPercent)
        assertEquals("168k", d.remaining)
        assertEquals(65, d.remainingPercent)
    }

    @Test fun detailsWithoutAWindowDropPercentagesAndRemainder() {
        val d = ContextUsage.details(contextSize = 90_000.0, maxContextSize = null, contextCacheRead = 86_000.0)
        assertEquals("86k", d.cacheRead)
        assertEquals("90k", d.used)
        assertNull(d.usedPercent)
        assertNull(d.remaining)
        assertNull(d.remainingPercent)
    }

    @Test fun detailsTreatZeroAndNullWindowsTheSame() {
        val zero = ContextUsage.details(90_000.0, 0.0, null)
        val absent = ContextUsage.details(90_000.0, null, null)
        assertEquals(absent, zero)
    }

    @Test fun detailsHideCacheReadUnlessPositive() {
        assertNull(ContextUsage.details(90_000.0, 258_000.0, null).cacheRead)
        assertNull(ContextUsage.details(90_000.0, 258_000.0, 0.0).cacheRead)
        assertNull(ContextUsage.details(90_000.0, 258_000.0, -5.0).cacheRead)
        assertEquals("500", ContextUsage.details(90_000.0, 258_000.0, 500.0).cacheRead)
    }

    @Test fun detailsClampTheRemainingCountAtZero() {
        val d = ContextUsage.details(contextSize = 300_000.0, maxContextSize = 258_000.0, contextCacheRead = null)
        assertEquals("0", d.remaining)
        assertEquals(100, d.usedPercent)
        assertEquals(0, d.remainingPercent)
    }

    // ------------------------------------------------- contextBudgetTokens --

    @Test fun codexBudgetIgnoresTheModel() {
        assertEquals(248_400.0, ContextUsage.contextBudgetTokens(null, "codex"))
        assertEquals(248_400.0, ContextUsage.contextBudgetTokens("gpt-5.4", "codex"))
    }

    @Test fun piBudgetUsesTheConservativeDefault() {
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens(null, "pi"))
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("any-model", "pi"))
    }

    @Test fun claudeBudgetDefaultsWhenTheModelIsMissing() {
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens(null, "claude"))
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("", "claude"))
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("   ", "claude"))
    }

    @Test fun claudeBudgetReadsPresetAndPrefixedModelIds() {
        // Picker aliases resolve to models with a native 1M window — mirrors
        // the web fallback (web/src/chat/modelConfig.ts).
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("sonnet", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("opus", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("fable", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("haiku", "claude"))
        // Full claude- ids keep the 200k default.
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("claude-sonnet-4-6", "claude"))
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("claude-opus-4-6", "claude"))
    }

    @Test fun presetSessionModelsKeepMostOfTheirWindowInUse() {
        // 200k of context against the 990k preset budget: ~80% left, not the
        // 0% a 190k misestimate would report.
        val sonnet = ContextUsage.indicator(usage(200_000.0), "sonnet", "claude")
        assertEquals("990k", sonnet?.budget)
        assertEquals(20, sonnet?.usedPercent)
        assertEquals(80, sonnet?.remainingPercent)
        assertEquals(ContextUsageWarning.NORMAL, sonnet?.warning)

        // The previously-missing haiku alias also keeps its percentage.
        val haiku = ContextUsage.indicator(usage(200_000.0), "haiku", "claude")
        assertEquals(80, haiku?.remainingPercent)
    }

    @Test fun claudeBudgetGrowsForLargeWindowModels() {
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("sonnet[1m]", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("opus[1m]", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("fable[1m]", "claude"))
        // Fable ships the large window even under its bare shorthand id.
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("fable", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("claude-fable-5", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("claude-anything[1m]", "claude"))
    }

    @Test fun claudeBudgetRejectsForeignModelIds() {
        assertNull(ContextUsage.contextBudgetTokens("gpt-5.4", "claude"))
        assertNull(ContextUsage.contextBudgetTokens("gemini-2.5-pro", "claude"))
    }

    @Test fun cursorBudgetParsesTheEncodedWindow() {
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("provider-x [context=200k]", "cursor"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("provider-x [context=1000000]", "cursor"))
        assertEquals(
            190_000.0,
            ContextUsage.contextBudgetTokens("provider-x [turbo, context=200k, extra=1]", "cursor"),
        )
    }

    @Test fun cursorBudgetRequiresAContextSegment() {
        assertNull(ContextUsage.contextBudgetTokens("provider-x", "cursor"))
        assertNull(ContextUsage.contextBudgetTokens("provider-x [ctx=200k]", "cursor"))
        assertNull(ContextUsage.contextBudgetTokens("provider-x [context=0]", "cursor"))
        assertNull(ContextUsage.contextBudgetTokens("provider-x [context=]", "cursor"))
        assertNull(ContextUsage.contextBudgetTokens(null, "cursor"))
    }

    @Test fun flavorsWithoutAEstimateReturnNull() {
        assertNull(ContextUsage.contextBudgetTokens("sonnet", null))
        assertNull(ContextUsage.contextBudgetTokens("sonnet", "opencode"))
        assertNull(ContextUsage.contextBudgetTokens("sonnet", "copilot"))
        assertNull(ContextUsage.contextBudgetTokens("sonnet", "agy"))
    }

    // ---------------------------------------------------------- indicator --

    private fun usage(
        contextSize: Double,
        contextWindow: Double? = null,
        model: String? = null,
        cacheRead: Double = 0.0,
    ) = LatestUsage(
        inputTokens = 0.0,
        outputTokens = 0.0,
        cacheCreation = 0.0,
        cacheRead = cacheRead,
        contextSize = contextSize,
        contextWindow = contextWindow,
        model = model,
        timestamp = 0L,
    )

    @Test fun indicatorStaysHiddenUntilUsageExists() {
        assertNull(ContextUsage.indicator(usage = null, sessionModel = "sonnet", flavor = "claude"))
    }

    @Test fun indicatorPrefersTheReportedWindowOverAnyEstimate() {
        val i = ContextUsage.indicator(usage(90_000.0, contextWindow = 258_400.0), "gpt-5.4", "claude")
        assertEquals("90k", i?.used)
        assertEquals("258k", i?.budget)
        assertEquals(35, i?.usedPercent)
        assertEquals(65, i?.remainingPercent)
        assertEquals(ContextUsageWarning.NORMAL, i?.warning)
    }

    @Test fun indicatorFallsBackToTheFlavorModelEstimate() {
        // No window on the usage, no model anywhere: the flavor default applies.
        val defaultWindow = ContextUsage.indicator(usage(90_000.0), null, "claude")
        assertEquals("190k", defaultWindow?.budget)
        assertEquals(47, defaultWindow?.usedPercent)
        assertEquals(53, defaultWindow?.remainingPercent)
        assertEquals(ContextUsageWarning.NORMAL, defaultWindow?.warning)

        // The usage model wins over the session model when both exist.
        val usageModelWins = ContextUsage.indicator(usage(90_000.0, model = "sonnet[1m]"), "gpt-5.4", "claude")
        assertEquals("990k", usageModelWins?.budget)

        // Without a usage model the session model feeds the estimate.
        val sessionModelUsed = ContextUsage.indicator(usage(90_000.0, model = null), "sonnet[1m]", "claude")
        assertEquals("990k", sessionModelUsed?.budget)
    }

    @Test fun indicatorShowsOnlyTheSizeWhenNoEstimateExists() {
        val i = ContextUsage.indicator(usage(90_000.0, model = "gpt-5.4"), "gpt-5.4", "claude")
        assertEquals("90k", i?.used)
        assertNull(i?.budget)
        assertNull(i?.usedPercent)
        assertNull(i?.remainingPercent)
        assertEquals(ContextUsageWarning.NORMAL, i?.warning)
    }

    @Test fun indicatorWithoutAFlavorShowsOnlyTheSize() {
        val i = ContextUsage.indicator(usage(120_000.0), "sonnet", null)
        assertEquals("120k", i?.used)
        assertNull(i?.budget)
    }

    @Test fun indicatorEscalatesAsTheWindowFills() {
        fun band(size: Double): ContextUsageWarning? =
            ContextUsage.indicator(usage(size), null, "claude")?.warning

        assertEquals(ContextUsageWarning.NORMAL, band(100_000.0))
        assertEquals(ContextUsageWarning.ELEVATED, band(140_000.0))
        assertEquals(ContextUsageWarning.CRITICAL, band(175_000.0))
    }

    @Test fun indicatorCarriesRawNumbersForTheLabel() {
        // Codex-style: explicit window straight from the usage signal.
        val i = ContextUsage.indicator(usage(90_000.0, contextWindow = 258_400.0, cacheRead = 86_000.0), null, null)
        assertEquals("258k", i?.budget)
        assertEquals(65, i?.remainingPercent)
        assertEquals("90k", i?.used)
    }
}

class ContextUsageDetailsAndCatalogTest {
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
        for (model in listOf(
            "opus", "sonnet", "haiku", "fable",
            "opus[1m]", "sonnet[1m]", "fable[1m]", "claude-opus-4-8[1m]", "claude-fable-5",
        )) {
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
