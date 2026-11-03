import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'

// Drives the launcher's steer-queued-message RPC against a scripted
// claudeRemote(): one plain turn that exposes a steer target until the test
// ends it, mirroring how the real stream opens/closes the target.
const harness = vi.hoisted(() => ({
    steered: [] as string[],
    deliveries: [] as Array<(delivered: boolean) => void>,
    endTurn: null as (() => void) | null,
    signal: null as AbortSignal | null
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: any) => {
        const initial = await opts.nextMessage()
        if (!initial) return
        harness.signal = opts.signal
        let open = true
        opts.onSteeringTarget({
            mode: initial.mode,
            send: (message: { uuid: string; message: { content: string } }) => {
                if (!open) return false
                harness.steered.push(message.message.content)
                harness.deliveries.push((delivered) => {
                    if (delivered) void opts.onSteerEcho(message.uuid)
                })
                return true
            }
        })
        await new Promise<void>((resolve) => {
            harness.endTurn = resolve
            opts.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        open = false
        opts.onSteeringTarget(null)
        for (const resolve of harness.deliveries.splice(0)) resolve(false)
    }
}))

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        setOnPermissionRequest(): void {}
        getResponses(): Map<string, unknown> { return new Map() }
        onMessage(): void {}
        handleToolCall = async () => ({ behavior: 'allow', updatedInput: {} })
        reset(): void {}
        isAborted(): boolean { return false }
        handleModeChange(): void {}
    }
}))

vi.mock('./utils/sdkToLogConverter', () => ({
    SDKToLogConverter: class {
        currentContextWindow(): undefined { return undefined }
        updateSessionId(): void {}
        resetParentChain(): void {}
        convert(): null { return null }
        convertSidechainUserMessage(): null { return null }
        updateSelectedModel(): void {}
        generateInterruptedToolResult(): null { return null }
    }
}))

vi.mock('./utils/OutgoingMessageQueue', () => ({
    OutgoingMessageQueue: class {
        releaseToolCall(): void {}
        enqueue(): void {}
        async flush(): Promise<void> {}
        destroy(): void {}
    }
}))

import { claudeRemoteLauncher } from './claudeRemoteLauncher'
import { Session } from './session'

type Handler = (payload?: unknown) => unknown

function createClientStub() {
    const rpcHandlers = new Map<string, Handler>()
    let agentState: Record<string, unknown> = {}
    return {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: Handler) => {
                rpcHandlers.set(method, handler)
            }
        },
        rpcHandlers,
        sessionId: 'hapi-session',
        agentState: () => agentState,
        keepAlive: () => {},
        updateMetadata: (mutator: (metadata: any) => any) => { mutator({}) },
        updateAgentState: (mutator: (state: any) => any) => { agentState = mutator(agentState) },
        emitMessagesConsumed: vi.fn(),
        emitSteerIndeterminate: vi.fn(),
        setSteerDeliveryState: vi.fn(async () => true),
        sendClaudeSessionMessage: () => {},
        sendSessionEvent: (_event: unknown) => {},
        sendAgentMessage: vi.fn(),
        notePendingHubPromptEcho: vi.fn(),
        discardPendingHubPromptEcho: vi.fn(),
        discardPendingHubPromptEchoText: () => {}
    }
}

const DEFAULT_MODE: EnhancedMode = { permissionMode: 'default' }

async function startTurn() {
    const client = createClientStub()
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode))
    const session = new Session({
        api: {} as any,
        client: client as any,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        sessionId: null,
        claudeEnvVars: {},
        claudeArgs: [],
        mcpServers: {},
        messageQueue: queue,
        onModeChange: () => {},
        allowedTools: [],
        mode: 'remote',
        startedBy: 'runner',
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hook.json',
        permissionMode: 'default'
    })
    queue.push('Run the tests', DEFAULT_MODE, 'first')
    const launched = claudeRemoteLauncher(session as any)
    await vi.waitFor(() => expect(client.agentState().steeringActive).toBe(true))
    const steer = (localId: string) => client.rpcHandlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId })
    const stop = async () => {
        client.rpcHandlers.get(RPC_METHODS.Switch)?.()
        await launched
        session.stopKeepAlive()
    }
    return { client, queue, steer, stop }
}

describe('claudeRemoteLauncher steer', () => {
    afterEach(() => {
        harness.steered = []
        harness.deliveries = []
        harness.endTurn = null
        harness.signal = null
    })

    it('writes the queued row into the running turn and acks it once Claude picks it up', async () => {
        const { client, queue, steer, stop } = await startTurn()
        try {
            queue.push('Also run lint', DEFAULT_MODE, 'steer-1')

            await expect(steer('steer-1')).resolves.toEqual({ steered: true })
            expect(harness.steered).toEqual(['Also run lint'])
            expect(client.setSteerDeliveryState).toHaveBeenCalledWith(['steer-1'], 'dispatching')
            expect(queue.size()).toBe(0)
            expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true })

            harness.deliveries[0]!(true)
            await vi.waitFor(() => expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['steer-1'], { steered: true }))
            expect(queue.cancelByLocalId('steer-1')).toBe('consumed')
        } finally {
            await stop()
        }
    })

    it('rejects rows that cannot join the active turn and keeps them queued', async () => {
        const { queue, steer, stop } = await startTurn()
        try {
            queue.pushIsolated('/compact', DEFAULT_MODE, 'command')

            await expect(steer('command')).resolves.toEqual({
                steered: false,
                error: 'Steer requires guidance text; commands stay queued'
            })
            await expect(steer('missing')).resolves.toEqual({ steered: false, error: 'Message is no longer queued or is already being steered' })
            expect(harness.steered).toEqual([])
            expect(queue.pendingLocalIds()).toEqual(['command'])
        } finally {
            await stop()
        }
    })

    it('reports no steerable turn once the turn has ended', async () => {
        const { client, queue, steer, stop } = await startTurn()
        try {
            harness.endTurn!()
            await vi.waitFor(() => expect(client.agentState().steeringActive).toBe(false))
            queue.push('Late', DEFAULT_MODE, 'late')
            await expect(steer('late')).resolves.toEqual({ steered: false, error: 'No active Claude turn' })
        } finally {
            await stop()
        }
    })

    it('holds an unacknowledged steer when the process exits on its own', async () => {
        const { client, queue, steer, stop } = await startTurn()
        try {
            queue.push('Also run lint', DEFAULT_MODE, 'steer-1')
            await expect(steer('steer-1')).resolves.toEqual({ steered: true })

            harness.endTurn!()
            await vi.waitFor(() => expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']))
            expect(queue.pendingLocalIds()).not.toContain('steer-1')
            expect(client.setSteerDeliveryState).not.toHaveBeenCalledWith(['steer-1'], 'queued')
            expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true })
        } finally {
            await stop()
        }
    })

    it('holds an unacknowledged steer for explicit resolution after an abort', async () => {
        const { client, queue, steer, stop } = await startTurn()
        try {
            queue.push('Also run lint', DEFAULT_MODE, 'steer-1')
            await expect(steer('steer-1')).resolves.toEqual({ steered: true })

            await client.rpcHandlers.get(RPC_METHODS.Abort)!()
            await vi.waitFor(() => expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['steer-1']))
            expect(queue.pendingLocalIds()).not.toContain('steer-1')
            expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['steer-1'], { steered: true })
        } finally {
            await stop()
        }
    })
})
