import { describe, expect, it, spyOn } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { SyncEvent } from '@hapi/protocol/types'

function createEngine(store = new Store(':memory:')) {
    const io = {
        of: () => ({
            to: () => ({ emit: () => {} })
        })
    }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

describe('SyncEngine.steerQueuedMessage', () => {
    it('reconciles persisted dispatches after the hub restarts', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('restart-pending', { path: '/tmp/project' }, null, 'default')
        store.messages.addMessage(session.id, 'waiting for receipt', 'pending-steer')
        store.messages.setMessagesDeliveryState(session.id, ['pending-steer'], 'dispatching')
        const { engine } = createEngine(store)
        try {
            expect(store.messages.lookupQueuedMessage(session.id, 'pending-steer').status).toBe('indeterminate')
            expect(store.messages.getImmediateQueuedLocalMessages(session.id)).toEqual([])
        } finally {
            engine.stop()
        }
    })

    it.each(['end', 'expire'] as const)('holds an unconfirmed steer after session %s and accepts a late receipt', (reason) => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                `steer-${reason}`,
                { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
                { steeringActive: true, controlledByUser: false },
                'default'
            )
            const other = engine.getOrCreateSession('other', { path: '/tmp/other', host: 'localhost' }, null, 'default')
            store.messages.addMessage(session.id, 'waiting for receipt', 'pending-steer')
            store.messages.addMessage(session.id, 'ordinary queue', 'queued')
            store.messages.addMessage(session.id, 'already accepted', 'accepted')
            store.messages.addMessage(other.id, 'another session', 'other-steer')
            store.messages.setMessagesDeliveryState(session.id, ['pending-steer', 'accepted'], 'dispatching')
            store.messages.setMessagesDeliveryState(other.id, ['other-steer'], 'dispatching')
            store.recordMessagesConsumed(session.id, ['accepted'], 1_000, 'default')
            const events: SyncEvent[] = []
            engine.subscribe(event => events.push(event))

            if (reason === 'end') {
                engine.handleSessionEnd({ sid: session.id, time: Date.now() })
            } else {
                const cached = engine.getSessionByNamespace(session.id, 'default')!
                cached.active = true
                cached.activeAt = Date.now() - 120_000
                engine['expireInactive']()
            }

            expect(events.filter(event => event.type === 'messages-indeterminate')).toEqual([
                { type: 'messages-indeterminate', sessionId: session.id, localIds: ['pending-steer'], namespace: 'default' }
            ])
            expect(store.messages.lookupQueuedMessage(session.id, 'pending-steer').status).toBe('indeterminate')
            expect(store.messages.getImmediateQueuedLocalMessages(session.id).map(message => message.localId)).toEqual(['queued'])
            expect(store.messages.getUninvokedLocalMessages(other.id)[0]?.deliveryState).toBe('dispatching')

            store.recordMessagesConsumed(session.id, ['pending-steer'], 2_000, 'default')
            const received = store.messages.getAllMessages(session.id).find(message => message.localId === 'pending-steer')
            expect(received?.invokedAt).toBe(2_000)
            expect(received?.deliveryState).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('routes a Claude steer to the CLI without treating dispatch as consumption', async () => {
        const { store, engine } = createEngine()
        const steer = spyOn(engine['rpcGateway'], 'steerQueuedMessage').mockResolvedValue({ steered: true })
        try {
            const session = engine.getOrCreateSession(
                'steer-claude',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
                { steeringActive: true, controlledByUser: false },
                'default'
            )
            const message = store.messages.addMessage(session.id, { text: 'new direction' }, 'claude-local')
            expect(await engine.steerQueuedMessage(session.id, message.id)).toEqual({ status: 'steered', localId: 'claude-local' })
            expect(steer).toHaveBeenCalledWith(session.id, 'claude-local')
            expect(store.messages.lookupQueuedMessage(session.id, message.id).status).toBe('queued')
        } finally {
            steer.mockRestore()
            engine.stop()
        }
    })

    it('rejects every scheduled row, mature ones included, without invoking the CLI', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'steer-scheduled',
                { path: '/tmp/project', host: 'localhost', flavor: 'pi' },
                { requests: {}, completedRequests: {} },
                'default'
            )
            // A mature scheduled row: the fire time already passed, but the row
            // is still uninvoked and waiting for the scheduled-FIFO release.
            const message = store.messages.addMessage(
                session.id,
                { text: 'mature scheduled' },
                'mature-local',
                Date.now() - 1_000
            )

            const result = await engine.steerQueuedMessage(session.id, message.id)

            expect(result).toEqual({
                status: 'failed',
                error: 'Scheduled messages cannot be steered',
                localId: 'mature-local'
            })
            // The row must stay queued — untouched by the rejected steer.
            const lookup = store.messages.lookupQueuedMessage(session.id, message.id)
            expect(lookup.status).toBe('queued')
        } finally {
            engine.stop()
        }
    })

    it('rejects unsupported flavors without invoking the CLI', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'steer-opencode',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                { requests: {}, completedRequests: {} },
                'default'
            )
            const message = store.messages.addMessage(session.id, { text: 'hi' }, 'local-id')

            const result = await engine.steerQueuedMessage(session.id, message.id)

            expect(result).toEqual({
                status: 'failed',
                error: 'Steering is only supported for Claude, Pi, Codex, Cursor ACP, and Hermes sessions',
                localId: null
            })
        } finally {
            engine.stop()
        }
    })
})
