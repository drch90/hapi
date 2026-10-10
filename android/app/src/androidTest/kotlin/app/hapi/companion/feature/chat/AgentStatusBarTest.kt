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
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.feature.chat.composer.ChatComposer
import app.hapi.companion.ui.theme.HapiTheme
import java.util.Locale
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class AgentStatusBarTest {
    @get:Rule val compose = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val configuration = mutableStateOf(Configuration(context.resources.configuration).apply { setLocale(Locale.ENGLISH) })
    private val status = mutableStateOf<AgentStatusUi>(AgentStatusUi.Offline)

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
                            agentStatus = status.value,
                            contextUsage = ContextUsageUi(90_000.0, 258_000.0, null),
                            onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                        )
                    }
                }
            }
        }
    }

    private fun label(id: Int, vararg args: Any) = context.createConfigurationContext(configuration.value).getString(id, *args)

    @Test fun statusUpdatesAboveTheInputWithoutChangingTheDraftOrBlockingUsageDetails() {
        mount()
        val states = listOf(
            AgentStatusUi.Offline to label(R.string.chat_agent_offline),
            AgentStatusUi.Online to label(R.string.chat_agent_online),
            AgentStatusUi.Thinking to label(R.string.chat_agent_thinking),
            AgentStatusUi.PermissionRequired to label(R.string.chat_agent_permission_required),
            AgentStatusUi.BackgroundTasks(1) to label(R.string.chat_agent_background_one),
            AgentStatusUi.BackgroundTasks(3) to label(R.string.chat_agent_background_many, 3),
        )
        for ((current, text) in states) {
            compose.runOnIdle { status.value = current }
            val indicator = compose.onNodeWithTag("chat-agent-status").assertIsDisplayed().assertTextEquals(text)
            val editor = compose.onNodeWithTag("chat-composer-input").assertTextContains("Keep my draft")
            assertTrue(indicator.getUnclippedBoundsInRoot().bottom <= editor.getUnclippedBoundsInRoot().top)
        }
        compose.onNodeWithTag("chat-context-usage").performClick()
        compose.onNodeWithText("Used: 90k (35%)").assertIsDisplayed()
        compose.onNodeWithText(label(R.string.chat_context_close)).performClick()
        compose.onNodeWithTag("chat-composer-input").assertTextContains("Keep my draft")
    }

    @Test fun statusAndContextFitPhoneWidthAtLargeFontsInBothLanguages() {
        mount()
        for (locale in listOf(Locale.ENGLISH, Locale.SIMPLIFIED_CHINESE)) {
            for (fontScale in listOf(1f, 2f)) {
                compose.runOnIdle {
                    configuration.value = Configuration(context.resources.configuration).apply {
                        setLocale(locale)
                        this.fontScale = fontScale
                    }
                }
                for (current in listOf(AgentStatusUi.PermissionRequired, AgentStatusUi.BackgroundTasks(3))) {
                    compose.runOnIdle { status.value = current }
                    val text = if (current == AgentStatusUi.PermissionRequired) label(R.string.chat_agent_permission_required)
                        else label(R.string.chat_agent_background_many, 3)
                    val indicator = compose.onNodeWithTag("chat-agent-status").assertIsDisplayed().assertTextEquals(text)
                    val statusBounds = indicator.getUnclippedBoundsInRoot()
                    val contextBounds = compose.onNodeWithTag("chat-context-usage").assertIsDisplayed().getUnclippedBoundsInRoot()
                    val composerBounds = compose.onNodeWithTag("composer").getUnclippedBoundsInRoot()
                    assertTrue("Status fits at $locale / $fontScale", statusBounds.left >= composerBounds.left && statusBounds.right <= composerBounds.right)
                    assertTrue("Usage fits at $locale / $fontScale", contextBounds.left >= composerBounds.left && contextBounds.right <= composerBounds.right)
                    assertTrue("Status and usage do not overlap", statusBounds.right <= contextBounds.left || statusBounds.bottom <= contextBounds.top)
                }
            }
        }
    }
}
