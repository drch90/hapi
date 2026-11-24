import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createUsageRoutes } from './usage'

function createApp(store: Store, namespace: string, getSyncEngine?: Parameters<typeof createUsageRoutes>[1]): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createUsageRoutes(store, getSyncEngine))
    return app
}

describe('GET /api/usage/summary', () => {
    it('shows recovered Antigravity usage without changing a running session or adding chat messages', async () => {
        const store = new Store(':memory:')
        try {
            const conversationId = '91a533b7-d0ae-4466-8c1e-9dc5bcf29bac'
            const saved = store.sessions.getOrCreateSession('old-agy-wrapper', {
                path: '/tmp', host: 'test', flavor: 'agy', machineId: 'machine', agySessionId: conversationId
            }, null, 'default')
            store.sessions.setSessionActive(saved.id, true, saved.createdAt, 'default')
            const activeSession = store.sessions.getSessionByNamespace(saved.id, 'default')
            const runner = {
                getOnlineMachinesByNamespace: () => [{ id: 'machine', metadata: { capabilities: [MACHINE_CAPABILITIES.AgyNativeUsage] } }],
                getAgyNativeUsage: mock(async () => ({ conversationId, nextIndex: 1, pendingIndex: null,
                    hasMore: false, reset: false, calls: [{ requestId: 'native-request', createdAt: saved.createdAt,
                        model: null, inputTokens: 10, outputTokens: 2, cacheReadTokens: 80, cacheCreationTokens: 8 }] }))
            }
            const app = createApp(store, 'default', () => runner as never)
            for (let refresh = 0; refresh < 2; refresh++) {
                const response = await app.request('/api/usage/summary?range=7d')
                expect(response.status).toBe(200)
                expect((await response.json() as { byAgent: unknown[] }).byAgent).toEqual([
                    expect.objectContaining({ key: 'agy', requests: 1, totalTokens: 100 })
                ])
            }
            expect(runner.getAgyNativeUsage).toHaveBeenCalledTimes(1)
            expect(store.sessions.getSessionByNamespace(saved.id, 'default')).toEqual(activeSession)
            expect(store.messages.getMessagesAfterSeq(saved.id, 0)).toEqual([])

            runner.getAgyNativeUsage.mockClear()
            const refused = await createApp(store, 'tenant', () => runner as never).request('/api/usage/summary')
            const invalid = await app.request('/api/usage/summary?timeZone=Mars/Olympus')
            expect(refused.status).toBe(403)
            expect(invalid.status).toBe(400)
            expect(runner.getAgyNativeUsage).not.toHaveBeenCalled()
        } finally {
            store.close()
        }
    })

    it('returns a no-store summary for the hub owner', async () => {
        const store = new Store(':memory:')
        try {
            const response = await createApp(store, 'default').request('/api/usage/summary?range=30d')

            expect(response.status).toBe(200)
            expect(response.headers.get('cache-control')).toBe('no-store')
            const body = await response.json() as { range: { from: number | null; to: number | null }; totals: { requests: number } }
            expect(typeof body.range.from).toBe('number')
            expect(typeof body.range.to).toBe('number')
            expect(body.totals.requests).toBe(0)
        } finally {
            store.close()
        }
    })

    it('rejects non-default namespaces', async () => {
        const store = new Store(':memory:')
        try {
            const response = await createApp(store, 'tenant').request('/api/usage/summary')

            expect(response.status).toBe(403)
            expect(await response.json()).toEqual({ error: 'Usage summary is only available to the hub owner' })
        } finally {
            store.close()
        }
    })

    it('validates IANA time zones', async () => {
        const store = new Store(':memory:')
        try {
            for (const timeZone of ['America/New_York', 'Asia/Shanghai']) {
                const response = await createApp(store, 'default').request(`/api/usage/summary?timeZone=${encodeURIComponent(timeZone)}`)
                expect(response.status).toBe(200)
            }
            for (const timeZone of ['Mars/Olympus', 'x'.repeat(101)]) {
                const response = await createApp(store, 'default').request(`/api/usage/summary?timeZone=${encodeURIComponent(timeZone)}`)
                expect(response.status).toBe(400)
            }
        } finally {
            store.close()
        }
    })

    it('returns CLI account quotas across online machines on GET /api/usage/quotas', async () => {
        const store = new Store(':memory:')
        try {
            const fakeSyncEngine = {
                getOnlineMachinesByNamespace: () => [
                    {
                        id: 'machine-1',
                        active: true,
                        metadata: {
                            displayName: 'Dev Box',
                            host: 'dev-host',
                            capabilities: [MACHINE_CAPABILITIES.AgentQuotas]
                        }
                    }
                ],
                getAgentQuotas: async (_machineId: string, opts?: { refresh?: boolean }) => ({
                    fetchedAt: 1700000000000,
                    accounts: [
                        {
                            agent: 'codex' as const,
                            available: true,
                            status: 'ok' as const,
                            accountLabel: 'user@example.com',
                            planLabel: opts?.refresh ? 'Pro (Refreshed)' : 'Pro',
                            buckets: [
                                {
                                    id: 'codex-primary',
                                    label: 'Weekly (7d)',
                                    group: null,
                                    window: 'weekly',
                                    usedPercent: 18,
                                    remainingPercent: 82,
                                    resetsAt: 1700600000000
                                }
                            ],
                            updatedAt: 1700000000000
                        }
                    ]
                })
            }

            const app = new Hono<WebAppEnv>()
            app.use('*', async (c, next) => {
                c.set('namespace', 'default')
                await next()
            })
            app.route('/api', createUsageRoutes(store, () => fakeSyncEngine as never))

            const response = await app.request('/api/usage/quotas?refresh=1')
            expect(response.status).toBe(200)
            const body = await response.json() as { machines: Array<{ machineId: string; machineName: string | null; accounts: Array<{ planLabel?: string }> }> }
            expect(body.machines).toHaveLength(1)
            expect(body.machines[0]?.machineId).toBe('machine-1')
            expect(body.machines[0]?.machineName).toBe('Dev Box')
            expect(body.machines[0]?.accounts[0]?.planLabel).toBe('Pro (Refreshed)')
        } finally {
            store.close()
        }
    })
})
