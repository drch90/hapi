import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentBackend, PermissionRequest } from '@/agent/types'
import type { AgentState } from '@/api/types'
import { HermesPermissionHandler, hermesPermissionOutcome } from './permissionHandler'

const request: PermissionRequest = {
    id: 'permission-1', sessionId: 'native-1', toolCallId: 'permission-1', title: 'Edit sensitive file',
    rawInput: { tool: 'write_file', arguments: { path: '.env', content: 'value' } },
    options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Once' },
        { optionId: 'allow_always', kind: 'allow_always', name: 'Always' },
        { optionId: 'allow_session', kind: 'allow_always', name: 'Session' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
    ]
}

function harness() {
    let receive!: (request: PermissionRequest) => void
    let respond!: (response: unknown) => Promise<void>
    let state: AgentState = {}
    const backend = { onPermissionRequest: vi.fn(fn => { receive = fn }), respondToPermission: vi.fn(async () => {}), cancelPrompt: vi.fn(async () => {}) }
    const handler = new HermesPermissionHandler({
        rpcHandlerManager: { registerHandler: (_name, fn) => { respond = fn as typeof respond } },
        updateAgentState: fn => { state = fn(state) }
    }, backend as unknown as AgentBackend)
    return { handler, backend, receive: () => receive(request), respond: (value: unknown) => respond(value), state: () => state }
}

describe('Hermes permissions', () => {
    afterEach(() => vi.useRealTimers())

    it('selects session scope even when permanent scope is listed first', () => {
        expect(hermesPermissionOutcome(request, 'approved_for_session')).toEqual({ outcome: 'selected', optionId: 'allow_session' })
        expect(hermesPermissionOutcome({ ...request, options: [request.options[1]] }, 'approved')).toEqual({ outcome: 'cancelled' })
    })

    it('requires an explicit answer for sensitive edits and ignores a second response', async () => {
        const h = harness()
        h.receive()
        expect(h.backend.respondToPermission).not.toHaveBeenCalled()
        expect(h.state().requests?.[request.id]).toBeDefined()
        await h.respond({ id: request.id, approved: false, decision: 'denied' })
        await h.respond({ id: request.id, approved: true })
        expect(h.backend.respondToPermission).toHaveBeenCalledTimes(1)
        expect(h.backend.respondToPermission).toHaveBeenCalledWith('native-1', request, { outcome: 'selected', optionId: 'deny' })
        expect(h.state().requests).toEqual({})
    })

    it('withdraws timed-out requests and cannot approve a late answer', async () => {
        vi.useFakeTimers()
        const h = harness()
        h.receive()
        await vi.advanceTimersByTimeAsync(60_000)
        await h.respond({ id: request.id, approved: true })
        expect(h.backend.respondToPermission).toHaveBeenCalledTimes(1)
        expect(h.state().completedRequests?.[request.id].status).toBe('canceled')
    })

    it('cancels pending approvals on shutdown', async () => {
        const h = harness()
        h.receive()
        await h.handler.cancelAll('Session ended')
        expect(h.state().requests).toEqual({})
        expect(h.backend.respondToPermission).toHaveBeenCalledWith('native-1', request, { outcome: 'cancelled' })
    })
})
