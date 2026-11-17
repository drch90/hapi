package app.hapi.companion.feature.chat.composer

import app.hapi.companion.feature.chat.ComposerUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerSendGateTest {
    @Test
    fun aRunningAgentWithoutSteeringStillOffersStop() {
        val state = ComposerUiState(text = "", isSending = false, canSteer = false, canStop = true)

        assertEquals(ComposerPrimaryAction.Stop, composerSendGate(state, emptyList()).action)

        val withDraft = composerSendGate(state.copy(text = "Next task"), emptyList())
        assertEquals(ComposerPrimaryAction.Send, withDraft.action)
        assertTrue(withDraft.canSubmit)
    }
}
