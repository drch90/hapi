package app.hapi.data.push

import app.hapi.data.sse.EngineEvent
import app.hapi.protocol.wire.AgentStateRequest
import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.SyncEvent
import kotlin.test.*

class LocalNotificationPolicyTest {
    private fun message(json: String) = EngineEvent.Sync(SyncEvent.MessageReceived(
        sessionId = "session", message = DecryptedMessage("message-1", content = HapiJson.parseToJsonElement(json), createdAt = 1000)))

    @Test fun onlyExplicitCompletionsNotify() {
        for (content in listOf("""{"type":"event","data":{"type":"ready"}}""",
            """{"role":"agent","content":{"type":"event","data":{"type":"ready"}}}""")) {
            assertEquals("message:message-1", LocalNotificationPolicy.completion(message(content))!!.key)
        }
        assertNull(LocalNotificationPolicy.completion(message("""{"type":"output","data":{"type":"assistant","text":"done"}}""")))
        assertNull(LocalNotificationPolicy.completion(EngineEvent.Sync(SyncEvent.SessionEnded(sessionId = "s", reason = "error"), "e")))
        assertNull(LocalNotificationPolicy.completion(EngineEvent.Sync(SyncEvent.SessionEnded(sessionId = "s", reason = "terminated"), "e")))
        assertNotNull(LocalNotificationPolicy.completion(EngineEvent.Sync(SyncEvent.SessionEnded(sessionId = "s", reason = "completed"), "e")))
        assertNull(LocalNotificationPolicy.completion(EngineEvent.Sync(SyncEvent.SessionEnded(sessionId = "s", reason = "completed"))))
    }

    @Test fun taskNotificationsPreserveSummaryAndRejectKilledTasks() {
        val done = message("""{"type":"output","data":{"type":"system","subtype":"task_notification","status":"completed","summary":"All tests passed"}}""")
        assertEquals("All tests passed", LocalNotificationPolicy.completion(done)!!.body)
        val killed = message("""{"type":"output","data":{"type":"system","subtype":"task_notification","status":"killed","summary":"Stopped"}}""")
        assertNull(LocalNotificationPolicy.completion(killed))
        val wrapped = message("""{"content":{"type":"output","data":{"type":"user","message":{"content":"<task-notification><status>completed</status><summary>Finished</summary></task-notification>"}}}}""")
        assertEquals("Finished", LocalNotificationPolicy.completion(wrapped)!!.body)
    }

    @Test fun classifyQuestionAliasesWithoutMatchingArbitraryMcpTools() {
        for (tool in listOf("request_user_input", "functions.request_user_input", "AskUserQuestion", "ask_user_question", "CursorAskQuestion")) {
            val pending = LocalNotificationPolicy.pending("req", AgentStateRequest(tool,
                HapiJson.parseToJsonElement("""{"questions":[{"question":"Which branch?"}]}""")))
            assertTrue(pending.input)
            assertEquals("Which branch?", pending.preview)
        }
        assertFalse(LocalNotificationPolicy.pending("req", AgentStateRequest("mcp__custom__request_user_input")).input)
        assertFalse(LocalNotificationPolicy.pending("req", AgentStateRequest("Bash")).input)
    }

    @Test fun persistedLedgerDeduplicatesReplaysAndMergesCompletionSignals() {
        var clock = 1000L
        val ledger = LocalNotificationLedger(now = { clock })
        assertTrue(ledger.completion("s", "ready-1"))
        assertFalse(ledger.completion("s", "ended-1"))
        assertTrue(ledger.claim("request:s:req-1"))
        val restored = LocalNotificationLedger(ledger.snapshot(), now = { clock })
        clock += 6000
        assertFalse(restored.completion("s", "ready-1"))
        assertFalse(restored.completion("s", "ended-1"))
        assertTrue(restored.completion("s", "ready-2"))
        assertFalse(restored.claim("request:s:req-1"))
        assertTrue(restored.claim("request:s:req-2"))
        assertTrue(LocalNotificationLedger(now = { clock }).claim("request:s:req-1")) // another hub
    }

    @Test fun ledgerIsBoundedAndExpiresWithoutStoringContent() {
        var clock = 1000L
        val ledger = LocalNotificationLedger(now = { clock })
        repeat(3000) { ledger.claim("id-$it"); clock++ }
        assertEquals(2048, ledger.snapshot().size)
        clock += 8L * 24 * 60 * 60 * 1000
        assertTrue(ledger.snapshot().isEmpty())
    }
}
