import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'

// Regression coverage for the mode gate in the relaunch loop: an attempt whose
// first batch arrives via `pending` (i.e. the previous attempt parked it on a
// mode change) must still seed modeHash/mode. Before the fix it left
// modeHash=null, so the NEXT mode switch passed the `(modeHash && hash !==
// modeHash)` check and was fed into a process spawned with the old
// --permission-mode — e.g. an 'auto' turn silently running as 'default'
// (tiann/hapi permission "Auto 完全无效" report).
const harness = vi.hoisted(() => ({
    // One entry per claudeRemote() call that actually received an initial
    // message: the mode it would spawn with plus every message it consumed.
    spawns: [] as Array<{ permissionMode: string; model?: string; messages: string[] }>,
    onFirstTurn: null as (() => void) | null,
    bailouts: 0,
    triggerSwitch: null as (() => void) | null,
    // Message text that, once consumed, ends the test by firing the switch RPC.
    finalMessage: 'three'
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: any) => {
        const initial = await opts.nextMessage()
        if (!initial) {
            harness.bailouts += 1
            return
        }
        const spawn = {
            permissionMode: initial.mode.permissionMode as string,
            ...(initial.mode.model ? { model: initial.mode.model as string } : {}),
            messages: [initial.message as string]
        }
        harness.spawns.push(spawn)
        opts.onSessionFound(`session-${harness.spawns.length}`)
        if (harness.onFirstTurn) {
            const onFirstTurn = harness.onFirstTurn
            harness.onFirstTurn = null
            await opts.onReady()
            onFirstTurn()
        }
        // Mirror the real claudeRemote: a single call keeps consuming turns
        // until nextMessage() resolves null (mode change parked / abort).
        while (true) {
            if (spawn.messages.includes(harness.finalMessage)) {
                harness.triggerSwitch?.()
            }
            const next = await opts.nextMessage()
            if (!next) {
                return
            }
            spawn.messages.push(next.message as string)
        }
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

function createClientStub() {
    const rpcHandlers = new Map<string, () => void | Promise<void>>()
    return {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: () => void | Promise<void>) => {
                rpcHandlers.set(method, handler)
            }
        },
        rpcHandlers,
        keepAlive: () => {},
        updateAgentState: () => {},
        updateMetadata: (mutator: (metadata: any) => any) => { mutator({}) },
        emitMessagesConsumed: () => {},
        sendClaudeSessionMessage: () => {},
        sendSessionEvent: () => {},
        notePendingHubPromptEcho: () => {},
        discardPendingHubPromptEcho: () => {},
        discardPendingHubPromptEchoText: () => {}
    }
}

function createSession(client: ReturnType<typeof createClientStub>) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode))
    const session = new Session({
        api: {} as any,
        client: client as any,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        sessionId: null,
        claudeEnvVars: {},
        claudeArgs: undefined,
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
    return { session, queue }
}

describe('claudeRemoteLauncher mode gate after pending delivery', () => {
    afterEach(() => {
        harness.spawns = []
        harness.bailouts = 0
        harness.triggerSwitch = null
        harness.onFirstTurn = null
        harness.finalMessage = 'three'
        vi.clearAllMocks()
    })

    it('delivers queued messages separately while retaining the same Claude process', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client)
        try {
            for (const text of ['one', 'two', 'three']) queue.push(text, { permissionMode: 'default' }, text)
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }
            await claudeRemoteLauncher(session as any)
            expect(harness.spawns).toEqual([{ permissionMode: 'default', messages: ['one', 'two', 'three'] }])
        } finally { session.stopKeepAlive() }
    })

    it('a mode switch after a pending-delivered batch still forces a relaunch', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client)

        try {
            // default -> auto -> default: the middle switch parks 'two', so the
            // second attempt starts from `pending`. The third message then
            // switches modes again and must NOT be fed into the auto process.
            queue.push('one', { permissionMode: 'default' }, 'local-1')
            queue.push('two', { permissionMode: 'auto' }, 'local-2')
            queue.push('three', { permissionMode: 'default' }, 'local-3')
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.spawns).toEqual([
                { permissionMode: 'default', messages: ['one'] },
                { permissionMode: 'auto', messages: ['two'] },
                { permissionMode: 'default', messages: ['three'] }
            ])
        } finally {
            session.stopKeepAlive()
        }
    })
    it('seeds the same custom model after an abort and a permission-mode change', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client)
        let aborted: Promise<void> | undefined

        try {
            session.setModel('provider/custom-model')
            queue.push('one', { permissionMode: 'default', model: session.getModel() ?? undefined }, 'local-1')
            harness.onFirstTurn = () => {
                aborted = Promise.resolve(client.rpcHandlers.get(RPC_METHODS.Abort)!()).then(() => {
                    session.setPermissionMode('plan')
                    queue.push('two', { permissionMode: 'plan', model: session.getModel() ?? undefined }, 'local-2')
                })
            }
            harness.finalMessage = 'two'
            harness.triggerSwitch = () => { client.rpcHandlers.get(RPC_METHODS.Switch)?.() }

            await claudeRemoteLauncher(session as any)
            await aborted

            expect(harness.spawns).toEqual([
                { permissionMode: 'default', model: 'provider/custom-model', messages: ['one'] },
                { permissionMode: 'plan', model: 'provider/custom-model', messages: ['two'] }
            ])
            expect(session.getModel()).toBe('provider/custom-model')
        } finally {
            session.stopKeepAlive()
        }
    })
})
