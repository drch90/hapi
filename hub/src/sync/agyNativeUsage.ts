import { isObject, MACHINE_CAPABILITIES } from '@hapi/protocol'
import { AgyNativeUsageRequestSchema, type AgyNativeUsagePage } from '@hapi/protocol/apiTypes'
import type { Store, StoredSession } from '../store'
import type { UsageEvent } from '../store/usage'
import type { SyncEngine } from './syncEngine'

type UsageEngine = Pick<SyncEngine, 'getOnlineMachinesByNamespace' | 'getAgyNativeUsage'>
type NativeConversation = {
    key: string
    machineId: string
    conversationId: string
    sessions: StoredSession[]
}
type Cursor = {
    nextIndex: number
    pendingIndex: number | null
    refreshedAt: number
}

const REFRESH_INTERVAL_MS = 30_000
const REFRESH_BUDGET_MS = 4_000
const MAX_PAGES_PER_CONVERSATION = 16

function nativeIdentity(session: StoredSession): { machineId: string; conversationId: string } | null {
    if (!isObject(session.metadata) || session.metadata.flavor !== 'agy') return null
    const machineId = session.machineId ?? session.metadata.machineId
    const conversationId = session.metadata.agySessionId
    if (typeof machineId !== 'string' || !machineId || typeof conversationId !== 'string') return null
    if (!AgyNativeUsageRequestSchema.shape.conversationId.safeParse(conversationId).success) return null
    return { machineId, conversationId }
}

/** Recover real native calls for old wrappers without sending chat messages or resuming agents. */
export class AgyNativeUsageSync {
    private readonly cursors = new Map<string, Cursor>()
    private pending: Promise<void> | null = null
    private refreshedAt = -Infinity

    constructor(private readonly store: Store, private readonly getEngine: () => UsageEngine | null) {}

    async refresh(): Promise<void> {
        if (this.pending) return this.pending
        if (Date.now() - this.refreshedAt < REFRESH_INTERVAL_MS) return
        const engine = this.getEngine()
        if (!engine) return
        this.pending = this.refreshFromEngine(engine).finally(() => {
            this.refreshedAt = Date.now()
            this.pending = null
        })
        return this.pending
    }

    private async refreshFromEngine(engine: UsageEngine): Promise<void> {
        const onlineMachines = new Set(engine.getOnlineMachinesByNamespace('default')
            .filter(machine => machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgyNativeUsage))
            .map(machine => machine.id))
        const conversations = new Map<string, NativeConversation>()
        for (const session of this.store.sessions.getSessionsByNamespace('default')) {
            const identity = nativeIdentity(session)
            if (!identity || !onlineMachines.has(identity.machineId)) continue
            const key = JSON.stringify([identity.machineId, identity.conversationId])
            const conversation = conversations.get(key) ?? { key, ...identity, sessions: [] }
            conversation.sessions.push(session)
            conversations.set(key, conversation)
        }
        for (const key of this.cursors.keys()) {
            if (!conversations.has(key)) this.cursors.delete(key)
        }
        const queue = [...conversations.values()].sort((a, b) =>
            (this.cursors.get(a.key)?.refreshedAt ?? 0) - (this.cursors.get(b.key)?.refreshedAt ?? 0))
        const deadline = Date.now() + REFRESH_BUDGET_MS
        let next = 0
        // Bound concurrent reads and total refresh work so an unavailable native
        // store cannot hold the dashboard open indefinitely. Machine RPCs also time out.
        const worker = async () => {
            while (next < queue.length && Date.now() < deadline) {
                const conversation = queue[next++]!
                try {
                    await this.refreshConversation(engine, conversation, deadline)
                } catch {
                    // An offline runner, missing native DB or unsupported native
                    // format must leave already indexed usage available.
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker))
    }

    private async refreshConversation(engine: UsageEngine, conversation: NativeConversation, deadline: number): Promise<void> {
        const { key, machineId, conversationId } = conversation
        const sessions = conversation.sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        const since = sessions[0]!.createdAt
        const cursor = this.cursors.get(key) ?? { nextIndex: 0, pendingIndex: null, refreshedAt: 0 }
        this.cursors.set(key, cursor)
        cursor.refreshedAt = Date.now()
        for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_CONVERSATION && Date.now() < deadline; pageIndex++) {
            const fromIndex = cursor.nextIndex
            const page = await engine.getAgyNativeUsage(machineId, { conversationId, fromIndex, since })
            if (page.conversationId !== conversationId
                || (!page.reset && page.nextIndex < fromIndex)
                || (page.pendingIndex !== null && page.pendingIndex >= page.nextIndex)
                || (page.hasMore && page.nextIndex <= (page.reset ? 0 : fromIndex))) {
                throw new Error('Invalid native usage page')
            }
            this.recordCalls(sessions, conversation, page)
            if (page.reset) cursor.pendingIndex = null
            if (page.pendingIndex !== null) {
                cursor.pendingIndex = Math.min(cursor.pendingIndex ?? page.pendingIndex, page.pendingIndex)
            }
            cursor.nextIndex = page.nextIndex
            if (!page.hasMore) {
                // Revisit unfinished model calls (even across several pages),
                // plus the tail in case its usage is written after its status.
                cursor.nextIndex = Math.min(cursor.pendingIndex ?? Infinity, Math.max(0, page.nextIndex - 1))
                cursor.pendingIndex = null
                return
            }
        }
    }

    private recordCalls(sessions: StoredSession[], conversation: NativeConversation, page: AgyNativeUsagePage): void {
        const now = Date.now()
        // Metadata may have changed or a session may have been deleted while
        // the RPC was in flight. Never import into a different binding/namespace.
        const eligibleSessions = sessions.filter(session => {
            const current = this.store.sessions.getSessionByNamespace(session.id, 'default')
            const identity = current && nativeIdentity(current)
            return identity?.machineId === conversation.machineId && identity.conversationId === conversation.conversationId
        }).reverse()
        const events: Omit<UsageEvent, 'sourceSeq'>[] = []
        for (const call of page.calls) {
            const requestId = call.requestId.trim()
            const counts = [call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheCreationTokens]
            const total = counts.reduce((sum, value) => sum + value, 0)
            if (!requestId || counts.some(value => !Number.isSafeInteger(value) || value < 0)
                || !Number.isSafeInteger(total) || total <= 0
                || !Number.isSafeInteger(call.createdAt) || call.createdAt > now + 1_000) continue
            // A resumed native conversation can have several HAPI rows. Assign
            // each call once, to the latest row that existed when it was made.
            const session = eligibleSessions.find(item => item.createdAt <= call.createdAt)
            if (!session) continue
            events.push({
                sessionId: session.id,
                sourceKey: `agy|${JSON.stringify([conversation.conversationId, requestId])}`,
                createdAt: call.createdAt,
                agent: 'agy',
                model: call.model?.trim() || null,
                kind: 'delta',
                inputTokens: call.inputTokens + call.cacheReadTokens + call.cacheCreationTokens,
                outputTokens: call.outputTokens,
                cacheReadTokens: call.cacheReadTokens,
                cacheCreationTokens: call.cacheCreationTokens,
                lastInputTokens: null,
                lastOutputTokens: null,
                lastCacheReadTokens: null,
                lastCacheCreationTokens: null
            })
        }
        this.store.usage.recordNativeEvents(events)
    }
}
