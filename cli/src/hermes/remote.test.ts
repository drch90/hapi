import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { HermesSession, HermesMode } from './session'

const h = vi.hoisted(() => ({ backend: {} as Record<string, ReturnType<typeof vi.fn>>, close: null as null | ((e: Error) => void), stop: vi.fn() }))
vi.mock('./backend', () => ({ createHermesBackend: (close: (e: Error) => void) => { h.close = close; return h.backend } }))
vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: async () => ({ server: { stop: h.stop }, mcpServers: { hapi: { command: 'hapi', args: ['mcp'], env: {} } } }) }))
vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
import { HermesRemoteLauncher } from './remote'

function session(nativeId: string | null = null) {
    const queue = new MessageQueue2<HermesMode>(() => 'hermes')
    const handlers = new Map<string, (p: unknown) => Promise<unknown>>()
    let model: string | null = null
    const result = {
        path: '/tmp/hermes-test', logPath: '', queue, sessionId: nativeId, thinking: false,
        client: { rpcHandlerManager: { registerHandler: (key: string, fn: (p: unknown) => Promise<unknown>) => handlers.set(key, fn) },
            updateMetadata: vi.fn(), emitMessagesConsumed: vi.fn(), updateAgentState: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendAgentMessage: vi.fn(), sendSessionEvent: vi.fn(), flush: vi.fn(async () => true) },
        onSessionFound: vi.fn((id: string) => { result.sessionId = id }),
        onThinkingChange: vi.fn((value: boolean) => { result.thinking = value }),
        getModel: () => model, setModel: (value: string) => { model = value },
        getPermissionMode: () => 'acceptEdits', setPermissionMode: vi.fn(), pushKeepAlive: vi.fn()
    }
    return { result, handlers }
}

describe('Hermes remote lifecycle', () => {
    beforeEach(() => {
        h.stop.mockReset()
        h.backend = Object.fromEntries(['initialize', 'setSessionInfoUpdateListener', 'setUsageUpdateListener', 'onStderrError', 'onPermissionRequest', 'cancelPrompt', 'disconnect', 'setMode', 'setModel'].map(key => [key, vi.fn(async () => {})]))
        h.backend.supportsLoadSession = vi.fn(() => true)
        h.backend.getAvailableCommands = vi.fn(() => undefined)
        h.backend.setAvailableCommandsListener = vi.fn()
        h.backend.newSession = vi.fn(async () => 'native-new')
        h.backend.loadSession = vi.fn(async ({ sessionId }) => sessionId)
        h.backend.getSessionModelsMetadata = vi.fn(() => ({ currentModelId: 'provider:model', availableModels: [{ modelId: 'provider:model' }] }))
        h.backend.suppressUpdatesDuring = vi.fn(async fn => fn())
        h.backend.prompt = vi.fn(async (_id, _content, update) => { update({ type: 'text', text: 'answer' }) })
    })

    it('creates with MCP, applies native edit policy and forwards a turn', async () => {
        const { result } = session()
        result.queue.push('hello', {})
        result.queue.close()
        const ready = vi.fn(async () => { expect(h.backend.setMode).toHaveBeenCalledWith('native-new', 'accept_edits') })
        await new HermesRemoteLauncher(result as unknown as HermesSession, ready).launch()
        expect(h.backend.newSession).toHaveBeenCalledWith({ cwd: result.path, mcpServers: [{ name: 'hapi', command: 'hapi', args: ['mcp'], env: [] }] })
        expect(result.client.sendAgentMessage).toHaveBeenCalledWith({ type: 'message', message: 'answer' })
        expect(ready).toHaveBeenCalledOnce()
        expect(h.backend.disconnect).toHaveBeenCalledOnce()
        expect(h.stop).toHaveBeenCalledOnce()
    })

    it('loads the existing conversation with replay suppression and no new native session', async () => {
        const { result } = session('native-existing')
        result.queue.close()
        await new HermesRemoteLauncher(result as unknown as HermesSession, async () => {}).launch()
        expect(h.backend.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'native-existing' }))
        expect(h.backend.suppressUpdatesDuring).toHaveBeenCalledOnce()
        expect(h.backend.newSession).not.toHaveBeenCalled()
    })

    it('fails a missing native conversation without reporting ready or creating a replacement', async () => {
        const { result } = session('missing')
        h.backend.loadSession.mockRejectedValue(new Error('not found'))
        const ready = vi.fn(async () => {})
        await expect(new HermesRemoteLauncher(result as unknown as HermesSession, ready).launch()).rejects.toThrow('not found')
        expect(ready).not.toHaveBeenCalled()
        expect(h.backend.newSession).not.toHaveBeenCalled()
        expect(h.stop).toHaveBeenCalledOnce()
    })

    it('ends an idle wrapper when the native process dies', async () => {
        const { result } = session()
        const launcher = new HermesRemoteLauncher(result as unknown as HermesSession, async () => { h.close!(new Error('child exited')) })
        await expect(launcher.launch()).rejects.toThrow('child exited')
        expect(h.backend.disconnect).toHaveBeenCalledOnce()
    })

    it('interrupts a turn and revokes pending approvals', async () => {
        const { result, handlers } = session()
        result.queue.push('first', {})
        result.queue.close()
        h.backend.prompt.mockImplementation(async () => {
            await handlers.get('abort')?.({})
            result.queue.close()
        })
        await new HermesRemoteLauncher(result as unknown as HermesSession, async () => {}).launch()
        expect(h.backend.cancelPrompt).toHaveBeenCalledWith('native-new')
        expect(result.thinking).toBe(false)
    })

    it('does not change the advertised model when native model switching fails', async () => {
        const { result, handlers } = session()
        result.queue.close()
        h.backend.setModel.mockRejectedValue(new Error('model unavailable'))
        await new HermesRemoteLauncher(result as unknown as HermesSession, async () => {
            await expect(handlers.get('set-session-config')?.({ model: 'bad' })).rejects.toThrow('model unavailable')
            expect(result.getModel()).toBe('provider:model')
        }).launch()
    })

    it('isolates commands from adjacent prompts and rejects the native queue command', async () => {
        const { result } = session()
        const launcher = new HermesRemoteLauncher(result as unknown as HermesSession, async () => {})
        launcher.receive('first', 'first')
        launcher.receive('/TOOLS', 'tools')
        launcher.receive('second', 'second')
        launcher.receive('/queue hidden', 'unsupported')
        result.queue.close()
        await launcher.launch()
        expect(h.backend.prompt.mock.calls.map(call => call[1][0].text)).toEqual(['first', '/tools', 'second'])
        expect(result.client.emitMessagesConsumed).toHaveBeenCalledWith(['unsupported'], { clearQueuedThinkingGrace: true })
    })

    it('handles help locally and rejects busy mutations immediately', async () => {
        const { result, handlers } = session()
        const launcher = new HermesRemoteLauncher(result as unknown as HermesSession, async () => {})
        launcher.receive('/help', 'help')
        launcher.receive('work', 'work')
        result.queue.close()
        h.backend.prompt.mockImplementation(async () => {
            launcher.receive('/model other', 'model')
            launcher.receive('/reset', 'reset')
            launcher.receive('/compress', 'compress')
            await expect(handlers.get('set-session-config')?.({ model: 'other' })).rejects.toThrow(/finish/)
            expect(await handlers.get('listHermesModels')?.({ refresh: true })).toMatchObject({ success: false })
        })
        await launcher.launch()
        expect(h.backend.prompt).toHaveBeenCalledOnce()
        expect(h.backend.setModel).not.toHaveBeenCalled()
        expect(result.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('/steer') }))
        expect(result.client.emitMessagesConsumed.mock.calls.map(call => call[0])).toEqual([['model'], ['reset'], ['compress']])
    })

    it('refreshes canonical provider identity after a switch without replay or a new session', async () => {
        const { result, handlers } = session()
        result.queue.close()
        h.backend.loadSession.mockImplementation(async ({ sessionId }) => {
            h.backend.getSessionModelsMetadata.mockReturnValue({ currentModelId: 'custom:office:qwen:32b', availableModels: [
                { modelId: 'custom:office:qwen:32b', name: 'qwen:32b', description: 'Provider: Office • current' }
            ] })
            return sessionId
        })
        await new HermesRemoteLauncher(result as unknown as HermesSession, async () => {
            await handlers.get('set-session-config')?.({ model: 'qwen:32b' })
            expect(result.getModel()).toBe('custom:office:qwen:32b')
            expect(await handlers.get('listHermesModels')?.({})).toMatchObject({ success: true,
                availableModels: [expect.objectContaining({ providerLabel: 'Office' })] })
            expect(h.backend.suppressUpdatesDuring).toHaveBeenCalledOnce()
            expect(h.backend.newSession).toHaveBeenCalledOnce()
        }).launch()
    })

    it('marks a switch with missing canonical state unknown, then recovers through refresh', async () => {
        const { result, handlers } = session()
        result.queue.close()
        h.backend.loadSession.mockImplementationOnce(async () => {
            h.backend.getSessionModelsMetadata.mockReturnValue({ currentModelId: null, availableModels: [] })
            return 'native-new'
        })
        await new HermesRemoteLauncher(result as unknown as HermesSession, async () => {
            await expect(handlers.get('set-session-config')?.({ model: 'other' })).rejects.toThrow(/refreshed/)
            expect(result.getModel()).toBeNull()
            expect(await handlers.get('listHermesModels')?.({})).toMatchObject({ success: false, currentModelId: null })
            h.backend.getSessionModelsMetadata.mockReturnValue({ currentModelId: 'canonical:other', availableModels: [] })
            expect(await handlers.get('listHermesModels')?.({ refresh: true })).toMatchObject({ success: true, currentModelId: 'canonical:other' })
        }).launch()
    })

    it('retains the accepted custom provider across startup and later generic native refreshes', async () => {
        const { result, handlers } = session()
        result.setModel('custom:office:qwen:32b')
        result.queue.close()
        h.backend.loadSession.mockImplementation(async ({ sessionId }) => {
            h.backend.getSessionModelsMetadata.mockReturnValue({ currentModelId: 'custom:qwen:32b', availableModels: [
                { modelId: 'custom:office:qwen:32b', name: 'qwen:32b', description: 'Provider: Office' },
                { modelId: 'custom:lab:qwen:32b', name: 'qwen:32b', description: 'Provider: Lab' }
            ] })
            return sessionId
        })
        await new HermesRemoteLauncher(result as unknown as HermesSession, async () => {
            expect(result.getModel()).toBe('custom:office:qwen:32b')
            expect(await handlers.get('listHermesModels')?.({ refresh: true })).toMatchObject({ currentModelId: 'custom:office:qwen:32b' })
            await handlers.get('set-session-config')?.({ model: 'custom:lab:qwen:32b' })
            expect(result.getModel()).toBe('custom:lab:qwen:32b')
        }).launch()
    })

    it('reserves idle refresh so a competing settings request is rejected', async () => {
        const { result, handlers } = session()
        result.queue.close()
        await new HermesRemoteLauncher(result as unknown as HermesSession, async () => {
            const refresh = handlers.get('listHermesModels')?.({ refresh: true })
            await expect(handlers.get('set-session-config')?.({ model: 'other' })).rejects.toThrow(/finish/)
            await refresh
            expect(h.backend.setModel).not.toHaveBeenCalled()
        }).launch()
    })
})
