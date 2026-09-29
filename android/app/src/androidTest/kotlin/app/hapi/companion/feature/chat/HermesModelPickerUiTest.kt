package app.hapi.companion.feature.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.ui.components.HermesModelPicker
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.HermesModelSummary
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class HermesModelPickerUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun searchSelectsFullProviderIdentityAndBusyStateDisablesChanges() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val office = "custom:office:qwen:32b"
        val lab = "custom:lab:qwen:32b"
        var selected by mutableStateOf<String?>(null)
        var busy by mutableStateOf(false)
        var refreshes = 0
        compose.setContent {
            HapiTheme {
                HermesModelPicker(
                    listOf(HermesModelSummary(office, "qwen:32b", providerLabel = "Office"),
                        HermesModelSummary(lab, "qwen:32b", providerLabel = "Lab")),
                    selected, loading = false, error = null, disabled = busy,
                    onSelect = { selected = it }, onRefresh = { refreshes++ },
                )
            }
        }
        compose.onNodeWithText(context.getString(R.string.hermes_model_search)).performTextInput("office")
        compose.onNodeWithText(lab).assertDoesNotExist()
        compose.onNodeWithText(office).performClick()
        compose.runOnIdle { assertEquals(office, selected) }
        compose.onNodeWithText(context.getString(R.string.hermes_model_refresh)).performClick()
        compose.runOnIdle { assertEquals(1, refreshes); busy = true }
        compose.onNode(hasClickAction() and hasText(office, substring = true)).assertIsNotEnabled()
        compose.onNodeWithText(context.getString(R.string.hermes_model_refresh)).assertIsNotEnabled()
    }
}
