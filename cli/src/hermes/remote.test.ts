import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ApiClient } from '@/api/api'
import type { Machine, Session } from '@/api/types'
import { configuration } from '@/configuration'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { HermesSession, type HermesMode } from './session'

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
            getMetadata: vi.fn(() => null), updateMetadata: vi.fn(), emitMessagesConsumed: vi.fn(), emitSessionReady: vi.fn(), updateAgentState: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendAgentMessage: vi.fn(), sendSessionEvent: vi.fn(), flush: vi.fn(async () => true) },
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
        expect(result.client.emitSessionReady).toHaveBeenCalledOnce()
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
        expect(result.client.emitSessionReady).toHaveBeenCalledOnce()
    })

    it('fails a missing native conversation without reporting ready or creating a replacement', async () => {
        const { result } = session('missing')
        h.backend.loadSession.mockRejectedValue(new Error('not found'))
        const ready = vi.fn(async () => {})
        await expect(new HermesRemoteLauncher(result as unknown as HermesSession, ready).launch()).rejects.toThrow('not found')
        expect(ready).not.toHaveBeenCalled()
        expect(result.client.emitSessionReady).not.toHaveBeenCalled()
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

    it.each(['idle', 'before dequeue'] as const)('accepts the next message after stopping a resumed session %s', async (when) => {
        const { result, handlers } = session('native-existing')
        result.queue.onBatchConsumed = localIds => result.client.emitMessagesConsumed(localIds)
        h.backend.prompt.mockImplementation(async (_id, _content, update) => {
            update({ type: 'text', text: 'continued' })
            result.queue.close()
        })
        const launcher = new HermesRemoteLauncher(result as unknown as HermesSession, async () => {})
        const running = launcher.launch()
        try {
            await vi.waitFor(() => expect(result.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }))
            if (when === 'before dequeue') launcher.receive('cancel this prompt', 'cancelled')
            await handlers.get('abort')?.({})
            launcher.receive('continue the original conversation', 'next-message')

            await vi.waitFor(() => expect(result.client.sendAgentMessage).toHaveBeenCalledWith({ type: 'message', message: 'continued' }))
            expect(h.backend.prompt.mock.calls.map(call => call[1][0].text)).toEqual(['continue the original conversation'])
            expect(result.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['next-message'])
            expect(h.backend.newSession).not.toHaveBeenCalled()
        } finally {
            await launcher.kill()
            await running
        }
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

    it('archives, resumes and sends again after idle Stop through the real Hub', async () => {
        // globalSetup provides an isolated Hub. Only the native Hermes backend
        // and MCP bridge are mocked; readiness, RPC and delivery use real sockets.
        const api = await ApiClient.create()
        const machineInfo = await api.getOrCreateMachine({
            machineId: randomUUID(),
            metadata: { host: 'hermes-test', platform: process.platform, happyCliVersion: configuration.currentCliVersion }
        })
        const machine = api.machineSyncClient(machineInfo)
        const original = await api.getOrCreateSession({
            tag: randomUUID(),
            metadata: { path: configuration.happyHomeDir, host: 'hermes-test', machineId: machineInfo.id, flavor: 'hermes', startedBy: 'runner' },
            state: { controlledByUser: false, startingMode: 'remote' }
        })
        const auth = await fetch(`${configuration.apiUrl}/api/auth`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accessToken: configuration.cliApiToken })
        })
        expect(auth.status).toBe(200)
        const { token } = await auth.json() as { token: string }
        async function request<T>(path: string, body?: unknown): Promise<T> {
            const response = await fetch(`${configuration.apiUrl}/api${path}`, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(5_000)
            })
            expect(response.status).toBe(200)
            return await response.json() as T
        }
        let runtime: { session: HermesSession; launcher: HermesRemoteLauncher; running: ReturnType<HermesRemoteLauncher['launch']> } | null = null
        async function start(row: Session): Promise<void> {
            const client = api.sessionSyncClient(row)
            const current = new HermesSession({
                api, client, path: configuration.happyHomeDir, logPath: '',
                sessionId: row.metadata?.hermesSessionId ?? null,
                messageQueue: new MessageQueue2<HermesMode>(() => 'hermes'),
                permissionMode: 'default'
            })
            let ready!: () => void
            let failed!: (error: unknown) => void
            const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
            const launcher = new HermesRemoteLauncher(current, async () => { ready() })
            client.onUserMessage((message, localId) => launcher.receive(message.content.text, localId))
            client.onCancelQueuedMessage(localId => current.queue.cancelByLocalId(localId))
            client.onRetryQueuedMessage(localId => current.queue.releaseIndeterminateReservation(localId))
            const running = launcher.launch()
            void running.catch(failed)
            runtime = { session: current, launcher, running }
            await started
        }
        async function stop(): Promise<void> {
            const current = runtime
            runtime = null
            if (!current) return
            current.session.stopKeepAlive()
            try {
                await current.launcher.kill()
                await current.running
            } finally {
                try {
                    current.session.client.sendSessionDeath('completed')
                    await current.session.client.flush()
                } finally {
                    current.session.client.close()
                }
            }
        }
        const spawn = vi.fn(async (options: { existingSessionId?: string; resumeSessionId?: string }) => {
            expect(options.existingSessionId).toBe(original.id)
            expect(options.resumeSessionId).toBe('native-new')
            await start(await api.getSession(original.id))
            return { type: 'success' as const, sessionId: original.id }
        })
        machine.setRPCHandlers({ spawnSession: spawn, stopSession: async () => { await stop(); return 'stopped' }, requestShutdown() {} })
        machine.connect()
        try {
            await vi.waitFor(async () => {
                const { machines } = await request<{ machines: Machine[] }>('/machines')
                expect(machines.find(row => row.id === machineInfo.id)?.active).toBe(true)
            }, { timeout: 5_000 })
            await start(original)
            await request(`/sessions/${original.id}/archive`, {})
            expect((await api.getSession(original.id)).metadata?.lifecycleState).toBe('archived')
            expect(await request(`/sessions/${original.id}/resume`, {})).toEqual({ type: 'success', sessionId: original.id })

            for (const localId of ['after-resume', 'after-idle-stop']) {
                await request(`/sessions/${original.id}/messages`, { localId, text: localId })
                await vi.waitFor(async () => {
                    const state = await request<{ queuedLocalIds: string[]; invokedLocalMessages: Array<{ localId: string }> }>(
                        `/sessions/${original.id}/messages/queued-state`, { localIds: [localId] }
                    )
                    expect(state.queuedLocalIds).toEqual([])
                    expect(state.invokedLocalMessages).toEqual([expect.objectContaining({ localId })])
                }, { timeout: 3_000 })
                await vi.waitFor(() => expect(runtime?.session.thinking).toBe(false))
                await request(`/sessions/${original.id}/abort`, {})
            }
            expect(spawn).toHaveBeenCalledOnce()
            expect(h.backend.newSession).toHaveBeenCalledOnce()
            expect(h.backend.prompt.mock.calls.map(call => call[1][0].text)).toEqual(['after-resume', 'after-idle-stop'])
        } finally {
            try { await stop() } finally { machine.shutdown() }
        }
    }, 15_000)
})
