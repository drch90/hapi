import { describe, expect, it, spyOn } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function harness() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const session = engine.getOrCreateSession('hermes-resume', {
        path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'hermes', hermesSessionId: 'native-1'
    }, null, 'default', 'provider:model')
    engine.getOrCreateMachine('machine-1', { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' }, null, 'default')
    return { engine, session }
}

describe('Hermes hub resume', () => {
    it('requires the original machine and respects namespaces', async () => {
        const { engine, session } = harness()
        try {
            engine.getOrCreateMachine('other', { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' }, null, 'default')
            engine.handleMachineAlive({ machineId: 'other', time: Date.now() })
            expect(await engine.resumeSession(session.id, 'default')).toMatchObject({ type: 'error', code: 'no_machine_online' })
            expect(await engine.resumeSession(session.id, 'other-namespace')).toMatchObject({ type: 'error', code: 'access_denied' })
        } finally { engine.stop() }
    })

    it('coalesces resume requests, preserves both identities and waits for native readiness', async () => {
        const { engine, session } = harness()
        try {
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            let release!: () => void
            const gate = new Promise<void>(resolve => { release = resolve })
            const gateway = (engine as unknown as { rpcGateway: { spawnSession: SyncEngine['spawnSession'] } }).rpcGateway
            const spawn = spyOn(gateway, 'spawnSession').mockImplementation(async (...args) => {
                expect(args[2]).toBe('hermes')
                expect(args).toContain('native-1')
                expect(args).toContain(session.id)
                await gate
                return { type: 'success', sessionId: session.id }
            })
            spyOn(engine, 'waitForSessionActive').mockResolvedValue(true)
            const ready = spyOn(engine, 'waitForSessionReady').mockResolvedValue('ready')
            const first = engine.resumeSession(session.id, 'default')
            const second = engine.resumeSession(session.id, 'default')
            release()
            expect(await first).toEqual({ type: 'success', sessionId: session.id })
            expect(await second).toEqual({ type: 'success', sessionId: session.id })
            expect(spawn).toHaveBeenCalledTimes(1)
            expect(ready).toHaveBeenCalledTimes(1)
        } finally { engine.stop() }
    })
})
