import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), close: vi.fn(), command: 'hermes' }))
vi.mock('@/agent/backends/acp/AcpStdioTransport', () => ({ AcpStdioTransport: { create: h.create } }))
vi.mock('@/agent/agentLaunchCommand', () => ({ getAgentLaunchCommand: () => h.command }))

describe('Hermes creation model discovery', () => {
    beforeEach(() => {
        vi.resetModules()
        h.create.mockReset().mockImplementation(async () => ({ sendRequest: h.send, close: h.close }))
        h.close.mockReset().mockResolvedValue(undefined)
        h.send.mockReset().mockImplementation(async method => method === 'initialize' ? {} : {
            models: { currentModelId: 'custom:lab:model', availableModels: [
                { modelId: 'custom:lab:model', name: 'model', description: 'Provider: Lab • current' }
            ] }
        })
        h.command = 'hermes'
    })

    it('shares concurrent probes, caches success, refreshes explicitly and always closes without prompting', async () => {
        const { listHermesModelsForCwd } = await import('./modelDiscovery')
        const results = await Promise.all([listHermesModelsForCwd('/work'), listHermesModelsForCwd('/work')])
        expect(results[0]).toEqual(results[1])
        expect(results[0]).toMatchObject({ availableModels: [expect.objectContaining({ providerLabel: 'Lab' })] })
        await listHermesModelsForCwd('/work')
        expect(h.create).toHaveBeenCalledOnce()
        await listHermesModelsForCwd('/work', true)
        expect(h.create).toHaveBeenCalledTimes(2)
        expect(h.close).toHaveBeenCalledTimes(2)
        expect(h.send.mock.calls.map(call => call[0])).toEqual(['initialize', 'session/new', 'initialize', 'session/new'])
        expect(h.send).toHaveBeenCalledWith('session/new', { cwd: '/work', mcpServers: [] }, expect.anything())
    })

    it('does not cache failures and closes when initialization times out', async () => {
        const { listHermesModelsForCwd } = await import('./modelDiscovery')
        h.send.mockRejectedValueOnce(new Error('initialize timed out'))
        expect(await listHermesModelsForCwd('/work')).toEqual({ success: false, error: 'initialize timed out' })
        expect(h.close).toHaveBeenCalledOnce()
        expect(await listHermesModelsForCwd('/work')).toMatchObject({ success: true })
        expect(h.create).toHaveBeenCalledTimes(2)
    })

    it('keeps workspaces and executable selections separate', async () => {
        const { listHermesModelsForCwd } = await import('./modelDiscovery')
        await listHermesModelsForCwd('/work')
        await listHermesModelsForCwd('/other')
        h.command = '/custom/hermes'
        await listHermesModelsForCwd('/work')
        expect(h.create).toHaveBeenCalledTimes(3)
        expect(await listHermesModelsForCwd(' ')).toMatchObject({ success: false })
        expect(h.create).toHaveBeenCalledTimes(3)
    })
})
