package app.hapi.companion.feature.chat

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.feature.chat.composer.SessionEditText
import app.hapi.protocol.session.SessionReferences
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.*

@RunWith(AndroidJUnit4::class)
class SessionReferenceInputTest {
    @Test fun citationIsOneEditableAtomAndKeepsItsFullId() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val editor = SessionEditText(instrumentation.targetContext)
            val wire = "前文 " + SessionReferences.markdown("会话 [标题]", "full-session-id") + " 后文"
            editor.syncValue(wire)
            assertEquals("前文 \uFFFC 后文", editor.text.toString())
            assertEquals(wire, editor.serialize())
            editor.text.delete(3, 4)
            assertEquals("前文  后文", editor.serialize())
            // A local selection update with an unchanged external prop must not undo typing.
            editor.syncValue(wire)
            assertEquals("前文  后文", editor.serialize())
        }
    }

    @Test fun selectionInsertsReferenceWithoutDiscardingSurroundingText() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val editor = SessionEditText(instrumentation.targetContext)
            editor.setSerialized("说明 @会 尾部")
            editor.setSelection(5)
            editor.insert(SessionSummary("session-id", true,
                metadata = SessionSummaryMetadata(name = "会话", path = "/project"), hasConversationContent = true))
            assertEquals("说明 [会话](/sessions/session-id)  尾部", editor.serialize())
            assertNull(editor.query())
        }
    }
}
