import { describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ response: null as unknown, notify: null as null | ((method: string, params: unknown) => void) }))
vi.mock('./AcpStdioTransport', () => ({ AcpStdioTransport: {
    create: async () => ({
        onNotification: (handler: (method: string, params: unknown) => void) => { h.notify = handler }, onStderrError: vi.fn(), registerRequestHandler: vi.fn(), close: vi.fn(),
        sendRequest: async (method: string) => method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } } : h.response
    })
} }))
import { AcpSdkBackend } from './AcpSdkBackend'

describe('Hermes ACP native resume contract', () => {
    it('publishes advertised command descriptions and input hints, including withdrawal', async () => {
        const backend = new AcpSdkBackend({ command: 'hermes', flavor: 'hermes' })
        const listener = vi.fn()
        backend.setAvailableCommandsListener(listener)
        await backend.initialize()
        h.notify!('session/update', { sessionId: 'original', update: { sessionUpdate: 'available_commands_update', availableCommands: [
            { name: 'steer', description: 'Guide the agent', input: { hint: 'guidance' } }
        ] } })
        expect(backend.getAvailableCommands('original')).toEqual([{ name: 'steer', description: 'Guide the agent', inputHint: 'guidance' }])
        expect(listener).toHaveBeenCalledWith('original', backend.getAvailableCommands('original'))
        h.notify!('session/update', { sessionId: 'original', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } })
        expect(backend.getAvailableCommands('original')).toEqual([])
        await backend.disconnect()
        expect(backend.getAvailableCommands('original')).toBeUndefined()
    })

    it('does not reuse optimistic model state when authoritative load omits it', async () => {
        h.response = { models: { currentModelId: 'old', availableModels: [{ modelId: 'old' }] } }
        const backend = new AcpSdkBackend({ command: 'hermes', flavor: 'hermes' })
        await backend.initialize()
        await backend.loadSession({ sessionId: 'original', cwd: '/tmp', mcpServers: [] })
        h.response = {}
        await backend.setModel('original', 'requested', { flavor: 'hermes' })
        await backend.loadSession({ sessionId: 'original', cwd: '/tmp', mcpServers: [] })
        expect(backend.getSessionModelsMetadata('original')).toBeUndefined()
        await backend.disconnect()
    })
    it('preserves custom-provider descriptions from native catalogs', async () => {
        h.response = { models: { currentModelId: 'custom:lab:model:v2', availableModels: [
            { modelId: 'custom:lab:model:v2', name: 'model:v2', description: 'Provider: Research Lab • current' }
        ] } }
        const backend = new AcpSdkBackend({ command: 'hermes', flavor: 'hermes' })
        await backend.initialize()
        await backend.loadSession({ sessionId: 'original', cwd: '/tmp', mcpServers: [] })
        expect(backend.getSessionModelsMetadata('original')?.availableModels[0]).toEqual({
            modelId: 'custom:lab:model:v2', name: 'model:v2', description: 'Provider: Research Lab • current'
        })
        await backend.disconnect()
    })
    it.each([null, 'invalid', { sessionId: 'replacement' }])('rejects missing or replaced native sessions: %j', async response => {
        h.response = response
        const backend = new AcpSdkBackend({ command: 'hermes', flavor: 'hermes' })
        await backend.initialize()
        await expect(backend.loadSession({ sessionId: 'original', cwd: '/tmp', mcpServers: [] })).rejects.toThrow(/Hermes/)
        await backend.disconnect()
    })
    it('accepts the standard load response without a session id', async () => {
        h.response = { models: { currentModelId: 'model', availableModels: [{ modelId: 'model', name: 'Model' }] } }
        const backend = new AcpSdkBackend({ command: 'hermes', flavor: 'hermes' })
        await backend.initialize()
        expect(await backend.loadSession({ sessionId: 'original', cwd: '/tmp', mcpServers: [] })).toBe('original')
        expect(backend.getSessionModelsMetadata('original')?.currentModelId).toBe('model')
        await backend.setModel('original', 'new-model', { flavor: 'hermes' })
        expect(backend.getSessionModelsMetadata('original')?.currentModelId).toBe('new-model')
        await backend.disconnect()
    })
})
