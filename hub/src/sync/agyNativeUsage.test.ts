import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import type { AgyNativeUsagePage, AgyNativeUsageRequest } from '@hapi/protocol/apiTypes'
import { Store } from '../store'
import { AgyNativeUsageSync } from './agyNativeUsage'
import { getUsageSummary } from './usageService'

const conversationId = '91a533b7-d0ae-4466-8c1e-9dc5bcf29bac'
const otherConversationId = '4f616484-0e29-42e9-964c-d146b84c0ba5'
const start = Date.parse('2026-01-01T00:00:00Z')

describe('native Antigravity usage recovery', () => {
    let store: Store
    let now: number
    let clock: ReturnType<typeof spyOn<typeof Date, 'now'>>
    beforeEach(() => {
        store = new Store(':memory:')
        now = start
        clock = spyOn(Date, 'now').mockImplementation(() => now)
    })
    afterEach(() => {
        clock.mockRestore()
        store.close()
    })

    function session(tag = 'agy-session', metadata: Record<string, unknown> = {}, namespace = 'default') {
        return store.sessions.getOrCreateSession(tag, {
            path: '/tmp', host: 'test', flavor: 'agy', machineId: 'machine', agySessionId: conversationId, ...metadata
        }, null, namespace, 'current-model-is-not-historical')
    }

    function call(requestId = 'native-request', createdAt = start): AgyNativeUsagePage['calls'][number] {
        return { requestId, createdAt, model: null, inputTokens: 120, outputTokens: 50,
            cacheReadTokens: 40, cacheCreationTokens: 10 }
    }

    function page(calls = [call()], overrides: Partial<AgyNativeUsagePage> = {}): AgyNativeUsagePage {
        return { conversationId, nextIndex: 1, pendingIndex: null, hasMore: false, reset: false, calls, ...overrides }
    }

    function engine(read: (machineId: string, request: AgyNativeUsageRequest) => Promise<AgyNativeUsagePage> = async () => page()) {
        return {
            getOnlineMachinesByNamespace: mock(() => [
                { id: 'machine', metadata: { capabilities: [MACHINE_CAPABILITIES.AgyNativeUsage] } },
                { id: 'old-machine', metadata: { capabilities: [MACHINE_CAPABILITIES.AgentQuotas] } }
            ]),
            getAgyNativeUsage: mock(read)
        }
    }

    it('recovers an old wrapper with no usage messages, preserves unknown models and coalesces refreshes', async () => {
        const saved = session()
        const runner = engine()
        const sync = new AgyNativeUsageSync(store, () => runner as never)
        await Promise.all([sync.refresh(), sync.refresh(), sync.refresh()])
        await sync.refresh()
        expect(runner.getAgyNativeUsage).toHaveBeenCalledTimes(1)
        expect(runner.getAgyNativeUsage).toHaveBeenCalledWith('machine', { conversationId, fromIndex: 0, since: start })
        expect(store.usage.getScanStates([saved.id]).size).toBe(0)
        const summary = getUsageSummary(store, 'default', '7d')
        expect(summary.byAgent).toEqual([expect.objectContaining({ key: 'agy', requests: 1,
            inputTokens: 170, outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 10, totalTokens: 220 })])
        expect(summary.byModel.map(row => row.key)).toEqual(['unknown'])
        expect(store.messages.getMessagesAfterSeq(saved.id, 0)).toEqual([])
        expect(store.sessions.getSessionByNamespace(saved.id, 'default')).toEqual(saved)
        now += 30_001
        await sync.refresh()
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(1)
    })

    it('retains native times and known models through live replays, parser/epoch rebuilds and session merges', async () => {
        const saved = session()
        const sync = new AgyNativeUsageSync(store, () => engine() as never)
        await sync.refresh()
        now += 10 * 86_400_000
        store.messages.addMessage(saved.id, { role: 'agent', content: { type: 'codex', data: {
            type: 'round-summary', summary: { provider: 'agy', conversation_id: conversationId,
                request_id: 'native-request', model: 'actual-request-model',
                agy_usage: { input_tokens: 120, output_tokens: 50, cache_read_tokens: 40, cache_write_tokens: 10 } }
        } } })
        expect(getUsageSummary(store, 'default', '7d').totals.requests).toBe(0)
        expect(getUsageSummary(store, 'default', 'all').byModel[0]?.key).toBe('actual-request-model')
        await sync.refresh()
        expect(store.usage.getEvents([saved.id])[0]).toMatchObject({ sourceSeq: 0, createdAt: start, model: 'actual-request-model' })
        store.messages.bumpMessageEpoch(saved.id)
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(1)
        // Parser upgrades and message rebuilds both use replaceEvents.
        store.usage.recordScan(saved.id, store.messages.getMessageEpoch(saved.id), 0, [], true)
        expect(store.usage.getEvents([saved.id])).toHaveLength(1)
        const target = session('merged')
        store.usage.transferSession(saved.id, target.id)
        expect(store.usage.getEvents([target.id])[0]?.sourceSeq).toBe(0)
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(1)
    })

    it('groups resumed native conversations and deduplicates summaries in another HAPI row', async () => {
        const first = session('original')
        now += 1_000
        const second = session('resumed')
        now += 1_000
        const runner = engine(async () => page([call('first', start + 500), call('second', start + 1_500)]))
        await new AgyNativeUsageSync(store, () => runner as never).refresh()
        expect(runner.getAgyNativeUsage).toHaveBeenCalledTimes(1)
        expect(store.usage.getEvents([first.id]).map(event => event.createdAt)).toEqual([start + 500])
        expect(store.usage.getEvents([second.id]).map(event => event.createdAt)).toEqual([start + 1_500])
        store.messages.addMessage(first.id, { role: 'agent', content: { type: 'codex', data: {
            type: 'round-summary', summary: { provider: 'agy', conversation_id: conversationId,
                request_id: 'second', model: 'native-model', agy_usage: { input_tokens: 120, output_tokens: 50,
                    cache_read_tokens: 40, cache_write_tokens: 10 } }
        } } })
        const summary = getUsageSummary(store, 'default', 'all')
        expect(summary.totals).toMatchObject({ requests: 2, totalTokens: 440, sessions: 2 })
        expect(summary.byModel.find(row => row.key === 'native-model')?.requests).toBe(1)
    })

    it('only reads linked owner conversations on capable online machines', async () => {
        session('eligible')
        session('other-namespace', {}, 'tenant')
        session('wrong-agent', { flavor: 'codex' })
        session('offline', { machineId: 'offline' })
        session('old-runner', { machineId: 'old-machine' })
        session('invalid-id', { agySessionId: '../../private' })
        session('missing-id', { agySessionId: null })
        const runner = engine()
        await new AgyNativeUsageSync(store, () => runner as never).refresh()
        expect(runner.getAgyNativeUsage).toHaveBeenCalledTimes(1)
        expect(runner.getOnlineMachinesByNamespace).toHaveBeenCalledWith('default')
        expect(getUsageSummary(store, 'tenant', 'all').totals.requests).toBe(0)
    })

    it('continues past missing native stores and rejects changed identities, unsafe counts and pre-HAPI timestamps', async () => {
        const saved = session()
        session('missing', { agySessionId: otherConversationId })
        const runner = engine(async (_machineId, request) => {
            if (request.conversationId === otherConversationId) throw new Error('Native DB is unavailable')
            return page([call('old', start - 1), call('future', now + 60_000),
                { ...call('overflow'), inputTokens: Number.MAX_SAFE_INTEGER },
                { ...call('negative'), inputTokens: -1 }, call()])
        })
        const sync = new AgyNativeUsageSync(store, () => runner as never)
        await sync.refresh()
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(1)
        now += 30_001
        runner.getAgyNativeUsage.mockImplementation(async () => page([call('wrong-conversation')], { conversationId: otherConversationId }))
        await sync.refresh()
        expect(store.usage.getEvents([saved.id])).toHaveLength(1)
        now += 30_001
        runner.getAgyNativeUsage.mockImplementation(async () => {
            const current = store.sessions.getSessionByNamespace(saved.id, 'default')!
            store.sessions.updateSessionMetadata(saved.id, { ...(current.metadata as object), agySessionId: otherConversationId }, current.metadataVersion, 'default')
            return page([call('changed-binding')])
        })
        await sync.refresh()
        expect(store.usage.getEvents([saved.id])).toHaveLength(1)
    })

    it('revisits pending calls across pages and resumes bounded backfills on the next refresh', async () => {
        session()
        let completed = false
        const runner = engine(async (_machineId, request) => {
            const index = request.fromIndex
            return page(index === 0 || index === 5 && completed ? [call(`call-${index}`)] : [], {
                nextIndex: index < 16 * 512 ? index + 512 : index + 1,
                pendingIndex: index === 0 && !completed ? 5 : null,
                hasMore: index < 16 * 512
            })
        })
        const sync = new AgyNativeUsageSync(store, () => runner as never)
        await sync.refresh()
        expect(runner.getAgyNativeUsage).toHaveBeenCalledTimes(16)
        now += 30_001
        await sync.refresh()
        expect(runner.getAgyNativeUsage.mock.calls[16]?.[1].fromIndex).toBe(16 * 512)
        completed = true
        now += 30_001
        await sync.refresh()
        expect(runner.getAgyNativeUsage.mock.calls[17]?.[1].fromIndex).toBe(5)
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(2)
    })

    it('accepts native trajectory resets without erasing already consumed requests', async () => {
        session()
        const runner = engine(async () => page([call()], { nextIndex: 50, pendingIndex: 30 }))
        const sync = new AgyNativeUsageSync(store, () => runner as never)
        await sync.refresh()
        now += 30_001
        runner.getAgyNativeUsage.mockImplementation(async () => page([call('after-reset')], { reset: true, nextIndex: 2 }))
        await sync.refresh()
        expect(runner.getAgyNativeUsage.mock.calls[1]?.[1].fromIndex).toBe(30)
        now += 30_001
        runner.getAgyNativeUsage.mockImplementation(async () => page([call('after-reset')], { nextIndex: 2 }))
        await sync.refresh()
        expect(runner.getAgyNativeUsage.mock.calls[2]?.[1].fromIndex).toBe(1)
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(2)
    })
})
