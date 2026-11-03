package app.hapi.data.store

import app.hapi.protocol.wire.SessionReadState
import app.hapi.protocol.wire.SessionReadStateRequest
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

class LastSeenStoreTest {
    @Test fun `manual unread and list preferences persist independently per hub`() = runTest {
        val first = Files.createTempDirectory("read-a").toFile()
        val second = Files.createTempDirectory("read-b").toFile()
        try {
            val store = LastSeenStore(backgroundScope, first)
            val row = summary("s", updatedAt = 99_999).copy(contentRevision = 100)
            store.markSeen("s", 100)
            store.markUnread("s")
            store.setListPreferences("machine-a", true)
            store.flushPersistence()
            val restored = LastSeenStore(backgroundScope, first)
            assertEquals(100L, restored.lastSeenAt("s"))
            assertEquals("unread", restored.state.value.pending["s"]?.request?.type)
            assertTrue(LastSeenStore.isUnread(row, restored.state.value))
            assertEquals("machine-a", restored.state.value.machineFilter)
            assertTrue(restored.state.value.activeOnly)
            assertTrue(LastSeenStore(backgroundScope, second).state.value.pending.isEmpty())
            restored.markAllSeen(listOf(row))
            assertEquals(100L, restored.lastSeenAt("s"))
            assertFalse(LastSeenStore.isUnread(row, restored.state.value))
            assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 101), restored.state.value))
        } finally { first.deleteRecursively(); second.deleteRecursively() }
    }

    @Test
    fun `observed revisions and outbox persist together and are scoped`() = runTest {
        val dir = Files.createTempDirectory("read-state").toFile()
        val store = LastSeenStore(backgroundScope, dir, "alice")
        store.markSeen("s1", 7)
        store.markSeen("s1", 3)
        val cold = LastSeenStore(backgroundScope, dir, "alice")
        assertEquals(7, cold.lastSeenAt("s1"))
        assertEquals(7, cold.state.value.pending["s1"]?.request?.readRevision)
        assertEquals(0, LastSeenStore(backgroundScope, dir, "bob").lastSeenAt("s1"))
        assertEquals(0, LastSeenStore(backgroundScope, Files.createTempDirectory("hub-b").toFile(), "alice").lastSeenAt("s1"))
    }

    @Test
    fun `mark all read follows an in flight manual unread without losing the newer intent`() = runTest {
        val store = LastSeenStore(backgroundScope)
        val requests = Channel<SessionReadStateRequest>(Channel.UNLIMITED)
        val unread = CompletableDeferred<Unit>()
        store.configure("default") { _, request ->
            requests.send(request)
            if (request.type == "unread") {
                unread.await()
                SessionReadState(0, true, 2)
            } else SessionReadState(request.readRevision!!, false, 3)
        }
        val row = summary("s").copy(contentRevision = 3, readState = SessionReadState(version = 1))
        store.markUnread("s", row.readState)
        assertEquals(SessionReadStateRequest("unread", expectedVersion = 1), requests.receive())
        store.markAllSeen(listOf(row))
        assertFalse(LastSeenStore.isUnread(row, store.state.value))
        unread.complete(Unit)
        assertEquals(SessionReadStateRequest("read", readRevision = 3, expectedVersion = 2), requests.receive())
        store.state.first { it.pending.isEmpty() }
        assertFalse(LastSeenStore.isUnread(row, store.state.value))
    }

    @Test
    fun `manual unread follows an in flight read without being acknowledged away`() = runTest {
        val store = LastSeenStore(backgroundScope)
        val requests = Channel<SessionReadStateRequest>(Channel.UNLIMITED)
        val read = CompletableDeferred<Unit>()
        store.configure("default") { _, request ->
            requests.send(request)
            if (request.type == "read") {
                read.await()
                SessionReadState(3, false, 2)
            } else SessionReadState(3, true, 3)
        }
        val row = summary("s").copy(contentRevision = 3, readState = SessionReadState(version = 1))
        store.markSeen("s", 3, row.readState)
        assertEquals(SessionReadStateRequest("read", readRevision = 3, expectedVersion = 1), requests.receive())
        store.markUnread("s", row.readState)
        assertTrue(LastSeenStore.isUnread(row, store.state.value))
        read.complete(Unit)
        assertEquals(SessionReadStateRequest("unread", expectedVersion = 2), requests.receive())
        store.state.first { it.pending.isEmpty() }
        assertTrue(LastSeenStore.isUnread(row, store.state.value))
    }

    @Test
    fun `mark all read uses the observed content revision and newest known manual state`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.configure("default") { _, _ -> SessionReadState(0, true, 2) }
        store.markUnread("s", SessionReadState(version = 1))
        store.state.first { it.pending.isEmpty() }
        store.setForeground(false)
        store.markAllSeen(listOf(summary("s", updatedAt = 99_999).copy(contentRevision = 3)))
        assertEquals(SessionReadStateRequest("read", readRevision = 3, expectedVersion = 2), store.state.value.pending["s"]?.request)
    }

    @Test
    fun `unread ignores metadata and includes running output`() = runTest {
        val store = LastSeenStore(backgroundScope)
        val row = summary("s1", updatedAt = 999_999)
        assertFalse(LastSeenStore.isUnread(row, store.state.value))
        assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 2), store.state.value))
        assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 2, active = true, thinking = true), store.state.value))
        assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 2, active = false, thinking = true), store.state.value))
        store.markSeen("s1", 1)
        assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 2), store.state.value))
        assertFalse(LastSeenStore.isUnread(row.copy(contentRevision = 2, readState = SessionReadState(2, false, 1)), store.state.value))
        assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 2, readState = SessionReadState(2, true, 2)), store.state.value))
    }

    @Test
    fun `stale read cannot erase newer manual unread`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markSeen("s1", 4, SessionReadState(version = 1))
        val row = summary("s1").copy(contentRevision = 4, readState = SessionReadState(4, true, 2))
        assertTrue(LastSeenStore.isUnread(row, store.state.value))
        store.markSeen("s1", 4, row.readState)
        assertFalse(LastSeenStore.isUnread(row, store.state.value))
    }

    @Test
    fun `old acknowledgement cannot delete a newer queued read`() = runTest {
        val store = LastSeenStore(backgroundScope)
        val revisions = Channel<Long>(Channel.UNLIMITED)
        val first = CompletableDeferred<Unit>()
        store.configure("default") { _, request ->
            val revision = request.readRevision!!
            revisions.send(revision)
            if (request.readRevision == 3L) first.await()
            SessionReadState(revision, false, revision)
        }
        store.markSeen("s1", 3)
        assertEquals(3, revisions.receive())
        store.markSeen("s1", 4)
        first.complete(Unit)
        assertEquals(4, revisions.receive())
        store.state.first { it.pending.isEmpty() }
        assertEquals(4, store.state.value.server["s1"]?.readRevision)
    }

    @Test
    fun `persistence failure does not claim read`() = runTest {
        val file = Files.createTempFile("read-state", ".json").toFile()
        val store = LastSeenStore(backgroundScope, file)
        assertTrue(runCatching { store.markSeen("s1", 3) }.isFailure)
        assertEquals(0, store.lastSeenAt("s1"))
        assertTrue(store.state.value.pending.isEmpty())
    }
}
