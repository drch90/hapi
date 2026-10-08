package app.hapi.protocol.window

import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.MessagesPage
import app.hapi.protocol.wire.OptionalField
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class QueuedMessageStateTest {
    private fun held(optimistic: Boolean = false): WindowMessage {
        val local = buildOptimisticMessage("local", "pending instruction", 1_000, status = MessageStatus.Indeterminate)
        return local.copy(wire = local.wire.copy(id = if (optimistic) "local" else "server", seq = 1,
            deliveryState = "indeterminate"), queueDismissed = true)
    }

    @Test fun `dismissal survives snapshot restore and stale unknown delivery refetch`() {
        val row = held()
        val saved = MessageWindowLogic.toPersisted(MessageWindowState("s", messages = listOf(row)))
        val json = HapiJson.encodeToString(PersistedMessageWindow.serializer(), saved)
        val restored = MessageWindowLogic.hydrate("s", HapiJson.decodeFromString(PersistedMessageWindow.serializer(), json))
        assertTrue(restored.messages.single().queueDismissed)
        assertTrue(MessageMerge.mergeMessages(restored.messages, listOf(row.copy(queueDismissed = false))).single().queueDismissed)
    }

    @Test fun `authoritative latest preserves dismissal only while the row remains unknown`() {
        val row = held()
        val state = MessageWindowState("s", messages = listOf(row))
        val page = MessagesPage(direction = "latest", limit = 200, epoch = 1, reset = true, hasMore = false)
        fun replace(rows: List<WindowMessage>) = MessageWindowLogic.applyLatestResponse(state, rows, page, true, mapOf(row.id to row))
        assertTrue(replace(listOf(row.copy(queueDismissed = false))).messages.single().queueDismissed)
        val requeued = row.copy(status = null, wire = row.wire.copy(deliveryState = null), queueDismissed = false)
        assertFalse(replace(listOf(requeued)).messages.single().queueDismissed)
        val invoked = row.copy(wire = row.wire.copy(invokedAt = OptionalField.Present(2_000), deliveryState = null), queueDismissed = false)
        assertFalse(replace(listOf(invoked)).messages.single().queueDismissed)
        assertTrue(replace(emptyList()).messages.isEmpty())
    }

    @Test fun `optimistic dismissal follows a server echo but not an explicit requeue`() {
        val optimistic = held(optimistic = true)
        val server = held().copy(queueDismissed = false)
        assertTrue(MessageMerge.mergeMessages(listOf(optimistic), listOf(server)).single().queueDismissed)
        val requeued = server.copy(status = null, wire = server.wire.copy(deliveryState = null))
        val merged = MessageMerge.mergeMessages(listOf(optimistic), listOf(requeued)).single()
        assertFalse(merged.queueDismissed)
        assertFalse(merged.isIndeterminate)
    }

    @Test fun `late acknowledgement clears the hold and cannot be downgraded by an unknown event`() {
        val state = MessageWindowState("s", messages = listOf(held()))
        val delivered = MessageWindowLogic.markConsumed(state, listOf("local"), 2_000)
        val row = delivered.messages.single()
        assertEquals(2_000L, row.invokedAtOrNull)
        assertEquals(MessageStatus.Sent, row.status)
        assertFalse(row.queueDismissed)
        assertNull(row.wire.deliveryState)
        assertEquals(delivered, MessageWindowLogic.markIndeterminate(delivered, listOf("local")))
        val stale = MessageMerge.mergeMessages(delivered.messages, state.messages).single()
        assertEquals(2_000L, stale.invokedAtOrNull)
        assertFalse(stale.queueDismissed)
        assertFalse(stale.isQueuedForInvocation)
    }

    @Test fun `requeue clears both stored unknown delivery markers and dismissal`() {
        val row = MessageWindowLogic.markRequeued(MessageWindowState("s", messages = listOf(held())), listOf("local")).messages.single()
        assertTrue(row.isQueuedForInvocation)
        assertFalse(row.isIndeterminate)
        assertFalse(row.queueDismissed)
        assertNull(row.wire.deliveryState)
    }

    @Test fun `unknown optimistic rows reconcile remote deletion but in flight sends are retained`() {
        val sending = buildOptimisticMessage("sending", "still sending", 2_000, status = MessageStatus.Sending)
        val state = MessageWindowState("s", messages = listOf(held(optimistic = true), sending))
        val ids = MessageWindowLogic.queuedReconcileCandidateLocalIds(state)
        assertEquals(listOf("local"), ids)
        assertEquals(listOf(sending), MessageWindowLogic.reconcileQueuedLocalIds(state, ids, emptyList()).messages)
    }
}
