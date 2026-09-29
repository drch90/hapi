package app.hapi.companion.ui.components

import app.hapi.protocol.wire.HermesModelSummary
import org.junit.Assert.assertEquals
import org.junit.Test

class HermesModelPickerTest {
    private val models = listOf(
        HermesModelSummary("custom:office:qwen:32b", "qwen:32b", providerLabel = "Office"),
        HermesModelSummary("custom:lab:qwen:32b", "qwen:32b", providerLabel = "Lab"),
        HermesModelSummary("custom:other:qwen:32b", "qwen:32b", providerLabel = "office"),
    )

    @Test
    fun `search matches provider and full model id without merging provider choices`() {
        assertEquals(3, groupHermesModels(models, "qwen:32b").size)
        assertEquals(listOf(models[1]), groupHermesModels(models, "lab").values.flatten())
        assertEquals(listOf(models[0]), groupHermesModels(models, "custom:office:").values.flatten())
    }
}
