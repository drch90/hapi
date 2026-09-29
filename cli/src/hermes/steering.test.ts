import { describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport'
import type { AcpSdkBackend } from '@/agent/backends/acp/AcpSdkBackend'
import type { HermesMode, HermesSession } from './session'
import { HermesSteering } from './steering'

function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

function harness() {
    const queue = new MessageQueue2<HermesMode>(() => 'hermes')
    const dispatched = deferred(), completed = deferred()
    const client = {
        setSteerDeliveryState: vi.fn(async () => true), emitSteerIndeterminate: vi.fn(),
        emitMessagesConsumed: vi.fn(), sendSessionEvent: vi.fn()
    }
    let active = true, generation = 1
    const backend = {
        getPromptGeneration: () => generation,
        beginSoftSteerPrompt: vi.fn(() => ({ dispatched: dispatched.promise, completed: completed.promise }))
    }
    const session = { queue, client, sessionId: 'native' } as unknown as HermesSession
    const steering = new HermesSteering(session, backend as unknown as AcpSdkBackend, () => active)
    queue.push('guidance', {}, 'message-1')
    return { queue, client, backend, steering, dispatched, completed,
        endTurn: () => { active = false }, nextGeneration: () => { generation++ } }
}

describe('Hermes live steer delivery', () => {
    it('acknowledges dispatch, prevents duplicates and holds the foreground until completion', async () => {
        const h = harness()
        const response = h.steering.steer('message-1')
        expect(await h.steering.steer('message-1')).toMatchObject({ steered: false })
        h.dispatched.resolve()
        expect(await response).toEqual({ steered: true })
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled()
        expect(h.steering.busy).toBe(true)
        expect(h.backend.beginSoftSteerPrompt).toHaveBeenCalledWith('native', [{ type: 'text', text: '/steer guidance' }])
        const drained = vi.fn()
        const drain = h.steering.drain().then(drained)
        await Promise.resolve()
        expect(drained).not.toHaveBeenCalled()
        h.completed.resolve()
        await drain
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['message-1'], { steered: true })
        expect(h.queue.size()).toBe(0)
        expect(h.steering.busy).toBe(false)
    })

    it.each(['endTurn', 'nextGeneration'] as const)('restores guidance if %s happens while durable state is saved', async change => {
        const h = harness()
        h.client.setSteerDeliveryState.mockImplementationOnce(async () => { h[change](); return true })
        expect(await h.steering.steer('message-1')).toMatchObject({ steered: false })
        await h.steering.drain()
        expect(h.backend.beginSoftSteerPrompt).not.toHaveBeenCalled()
        expect(h.queue.size()).toBe(1)
        expect(h.client.setSteerDeliveryState).toHaveBeenLastCalledWith(['message-1'], 'queued')
    })

    it('restores a definite native rejection without consuming the queued message', async () => {
        const h = harness()
        const response = h.steering.steer('message-1')
        const error = new Error('native rejected')
        h.dispatched.reject(error)
        h.completed.reject(error)
        expect(await response).toMatchObject({ steered: false, error: 'native rejected' })
        await h.steering.drain()
        expect(h.queue.size()).toBe(1)
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled()
    })

    it('holds an uncertain result out of the automatic queue until explicit retry', async () => {
        const h = harness()
        const response = h.steering.steer('message-1')
        h.dispatched.resolve()
        expect(await response).toEqual({ steered: true })
        h.completed.reject(Object.assign(new Error('connection lost'), { [ACP_INDETERMINATE_SYMBOL]: true }))
        await h.steering.drain()
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['message-1'])
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled()
        expect(h.queue.size()).toBe(0)
        expect(h.queue.releaseIndeterminateReservation('message-1')).toBe(true)
        h.queue.push('guidance', {}, 'message-1')
        expect(h.queue.size()).toBe(1)
    })

    it('holds guidance when saving dispatch state cannot be confirmed', async () => {
        const h = harness()
        h.client.setSteerDeliveryState.mockResolvedValueOnce(false)
        expect(await h.steering.steer('message-1')).toMatchObject({ steered: false })
        await h.steering.drain()
        expect(h.backend.beginSoftSteerPrompt).not.toHaveBeenCalled()
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['message-1'])
        expect(h.queue.size()).toBe(0)
    })

    it('preserves a dispatched reservation across abort until native completion', async () => {
        const h = harness()
        const response = h.steering.steer('message-1')
        h.dispatched.resolve()
        await response
        h.endTurn()
        h.queue.reset({ preserveDispatchingReservations: true })
        h.completed.resolve()
        await h.steering.drain()
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledOnce()
    })

    it('does not inject queued model/reset commands into a running turn', async () => {
        const h = harness()
        h.queue.pushIsolated('/reset', {}, 'reset')
        expect(await h.steering.steer('reset')).toMatchObject({ steered: false })
        expect(h.backend.beginSoftSteerPrompt).not.toHaveBeenCalled()
        expect(h.queue.size()).toBe(2)
    })
})
