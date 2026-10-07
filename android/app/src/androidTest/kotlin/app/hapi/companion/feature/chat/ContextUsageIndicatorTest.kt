package app.hapi.companion.feature.chat

import android.content.res.Configuration
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.feature.chat.composer.ChatComposer
import app.hapi.companion.ui.theme.HapiTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.util.Locale

class ContextUsageIndicatorTest {
    @get:Rule val compose = createComposeRule()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val configuration = mutableStateOf(Configuration(context.resources.configuration).apply { setLocale(Locale.ENGLISH) })
    private val usage = mutableStateOf<ContextUsageUi?>(null)

    private fun mount() {
        compose.setContent {
            val config = configuration.value
            CompositionLocalProvider(
                LocalContext provides context.createConfigurationContext(config),
                LocalConfiguration provides config,
                LocalDensity provides Density(LocalDensity.current.density, config.fontScale),
            ) {
                HapiTheme(darkTheme = config.fontScale > 1f, dynamicColor = false) {
                    Box(Modifier.width(320.dp).testTag("composer")) {
                        ChatComposer(
                            state = ComposerUiState("Keep my draft", false, false),
                            contextUsage = usage.value,
                            onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                        )
                    }
                }
            }
        }
    }

    private fun label(id: Int, vararg args: Any) = context.createConfigurationContext(configuration.value).getString(id, *args)

    @Test fun indicatorHidesUntilUsageArrivesAndDetailsFollowLiveUpdates() {
        mount()
        compose.onNodeWithTag("chat-context-usage").assertDoesNotExist()
        compose.runOnIdle { usage.value = ContextUsageUi(90_000.0, 258_000.0, 86_000.0) }
        compose.onNodeWithText("ctx 258k (65% left)").assertIsDisplayed()
        compose.onNodeWithContentDescription(label(R.string.chat_context_details)).performClick()
        compose.onNodeWithText("Cache: 86k").assertIsDisplayed()
        compose.onNodeWithText("Used: 90k (35%)").assertIsDisplayed()
        compose.onNodeWithText("Remaining: 168k (65%)").assertIsDisplayed()
        compose.runOnIdle { usage.value = ContextUsageUi(260_000.0, 258_000.0, null) }
        compose.onNodeWithText("Cache: 86k").assertDoesNotExist()
        compose.onNodeWithText("Used: 260k (100%)").assertIsDisplayed()
        compose.onNodeWithText("Remaining: 0 (0%)").assertIsDisplayed()
        compose.onNodeWithText(label(R.string.chat_context_close)).performClick()
        compose.onNodeWithTag("chat-composer-input").assertTextContains("Keep my draft")
        compose.runOnIdle { usage.value = ContextUsageUi(5_000.0, null, null) }
        compose.onNodeWithText("ctx 5k").performClick()
        compose.onNodeWithText("Used: 5k").assertIsDisplayed()
        compose.onAllNodesWithText("Remaining:", substring = true).assertCountEquals(0)
        compose.onAllNodesWithText("Cache:", substring = true).assertCountEquals(0)
    }

    @Test fun detailsRemainAccessibleAtLargeFontsInBothLanguages() {
        usage.value = ContextUsageUi(69.0, 200.0, 20.0)
        mount()
        for (locale in listOf(Locale.ENGLISH, Locale.SIMPLIFIED_CHINESE)) {
            for (fontScale in listOf(1f, 2f)) {
                compose.runOnIdle {
                    configuration.value = Configuration(configuration.value).apply { setLocale(locale); this.fontScale = fontScale }
                }
                val trigger = compose.onNodeWithTag("chat-context-usage").assertIsDisplayed()
                val bounds = trigger.getUnclippedBoundsInRoot()
                val composer = compose.onNodeWithTag("composer").getUnclippedBoundsInRoot()
                assertTrue("Usage fits narrow composer at $locale / $fontScale", bounds.right <= composer.right)
                trigger.performClick()
                compose.onNodeWithText(label(R.string.chat_context_cache, "20")).performScrollTo().assertIsDisplayed()
                compose.onNodeWithText(label(R.string.chat_context_used, "69", 35)).performScrollTo().assertIsDisplayed()
                compose.onNodeWithText(label(R.string.chat_context_remaining, "131", 65)).performScrollTo().assertIsDisplayed()
                compose.onNodeWithText(label(R.string.chat_context_close)).performClick()
            }
        }
    }
}
