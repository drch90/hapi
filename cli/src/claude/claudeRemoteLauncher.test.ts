import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'
import type { SDKUserMessage } from './sdk'

// These tests cover the one-time --resume flag's lifetime across the relaunch
// loop. The flag lives in session.claudeArgs and is the only resume anchor a
// remote Claude session has until Claude reports a session id back, so it must
// survive launch attempts that never reached Claude, and must be dropped both
// when it has been used and when the user explicitly discards the context.
const harness = vi.hoisted(() => ({
    callCount: 0,
    claudeArgsPerCall: [] as (string[] | undefined)[],
    initialMessages: [] as string[],
    triggerSwitch: null as (() => void) | null,
    switchAfterCall: 2,
    exercise: null as null | ((opts: any) => Promise<void>),
    convert: vi.fn((_message: unknown) => null)
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: any) => {
        const { parseSpecialCommand } = await import('@/parsers/specialCommands')

        harness.callCount += 1
        harness.claudeArgsPerCall.push(opts.claudeArgs ? [...opts.claudeArgs] : opts.claudeArgs)

        const initial = await opts.nextMessage()
        if (!initial) {
            // Mirrors claudeRemote()'s early return when the initial
            // nextMessage() resolves null (an isolate message got parked as
            // `pending`): it returns before spawning Claude, so onSessionFound
            // never fires and the --resume flag is never actually used.
            return
        }
        harness.initialMessages.push(initial.message)

        // Mirrors claudeRemote()'s /clear contract: it reports the context as
        // discarded and returns before spawning Claude, so onSessionFound
        // never fires here either.
        if (parseSpecialCommand(initial.message).type === 'clear') {
            opts.onSessionReset()
            return
        }

        // Mirrors a launch that actually spawns Claude and observes the
        // session id via the SDK's system/init message.
        opts.onSessionFound('captured-session-id')
        await harness.exercise?.(opts)

        if (harness.callCount === harness.switchAfterCall && harness.triggerSwitch) {
            // Stop the runMainLoop() while-loop so the test doesn't hang
            // waiting on a further claudeRemote() call. Mirrors the real
            // 'switch' RPC exit path already wired by setupAbortHandlers().
            harness.triggerSwitch()
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
        convert(message: unknown): null { return harness.convert(message) }
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
    const rpcHandlers = new Map<string, (...args: any[]) => any>()
    return {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: () => void | Promise<void>) => {
                rpcHandlers.set(method, handler)
            }
        },
        rpcHandlers,
        sessionId: 'hub-session',
        keepAlive: () => {},
        updateAgentState: vi.fn(),
        updateMetadata: (mutator: (metadata: any) => any) => { mutator({}) },
        emitMessagesConsumed: vi.fn(),
        setSteerDeliveryState: vi.fn(async () => true),
        emitSteerIndeterminate: vi.fn(),
        sendClaudeSessionMessage: () => {},
        sendSessionEvent: () => {},
        notePendingHubPromptEcho: () => {},
        discardPendingHubPromptEcho: () => {},
        discardPendingHubPromptEchoText: () => {}
    }
}

const RESUME_ARGS = ['--resume', 'original-session-id']

// claudeArgs is required rather than defaulted: passing `undefined` to a
// defaulted parameter would silently fall back to the default and hand the
// no-resume test a --resume flag it is supposed to be running without.
function createSession(
    client: ReturnType<typeof createClientStub>,
    claudeArgs: string[] | undefined
) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode))
    const session = new Session({
        api: {} as any,
        client: client as any,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        sessionId: null,
        claudeEnvVars: {},
        claudeArgs,
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

describe('claudeRemoteLauncher resume anchor', () => {
    afterEach(() => {
        harness.callCount = 0
        harness.claudeArgsPerCall = []
        harness.initialMessages = []
        harness.triggerSwitch = null
        harness.switchAfterCall = 2
        harness.exercise = null
        vi.clearAllMocks()
    })

    it('wires direct and queued steer to one live transport and suppresses replay transcript rows', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        const send = vi.fn((_message: SDKUserMessage) => true)
        harness.switchAfterCall = 1
        harness.triggerSwitch = () => { void client.rpcHandlers.get(RPC_METHODS.Switch)?.() }
        harness.exercise = async opts => {
            const mode = { permissionMode: 'default' as const }
            opts.onSteeringTarget({ mode, send })
            client.emitMessagesConsumed.mockClear()
            queue.push('new direction', mode, 'guidance')
            expect(await client.rpcHandlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'guidance' })).toEqual({ steered: true })
            expect(await session.steerQueuedMessage!('guidance')).toEqual({ steered: true })
            expect(send).toHaveBeenCalledOnce()
            expect(opts.signal.aborted).toBe(false)
            expect(client.emitMessagesConsumed).not.toHaveBeenCalled()
            const message = send.mock.calls[0]![0]
            const replay = { ...message, isReplay: true }
            opts.onMessage(replay)
            expect(harness.convert).not.toHaveBeenCalled()
            await opts.onSteerEcho(message.uuid)
            expect(client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['guidance'], { steered: true })
            opts.onSteeringTarget(null)
            opts.onResult()
            await opts.onReady()
        }
        try {
            queue.push('start', { permissionMode: 'default' }, 'initial')
            await claudeRemoteLauncher(session)
            expect(session.steerQueuedMessage).toBeNull()
            expect(await client.rpcHandlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'guidance' })).toMatchObject({ steered: false })
            expect(client.emitSteerIndeterminate).not.toHaveBeenCalled()
        } finally {
            session.stopKeepAlive()
        }
    })

    it('does not replay the original task after a transport failure following live input', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)
        const send = vi.fn((_message: SDKUserMessage) => true)
        const previousBackoff = process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS
        process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS = '0'
        harness.triggerSwitch = () => { void client.rpcHandlers.get(RPC_METHODS.Switch)?.() }
        harness.exercise = async opts => {
            if (harness.callCount !== 1) return
            const mode = { permissionMode: 'default' as const }
            opts.onSteeringTarget({ mode, send })
            queue.push('live guidance', mode, 'guidance')
            await session.steerQueuedMessage!('guidance')
            queue.push('later task', mode, 'later')
            throw new Error('transport failed after the steer write')
        }
        try {
            queue.push('original task with side effects', { permissionMode: 'default' }, 'original')
            await claudeRemoteLauncher(session)
            expect(harness.initialMessages).toEqual(['original task with side effects', 'later task'])
            expect(send).toHaveBeenCalledOnce()
            expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['guidance'])
            expect(client.emitMessagesConsumed).not.toHaveBeenCalledWith(['guidance'], { steered: true })
        } finally {
            session.stopKeepAlive()
            if (previousBackoff === undefined) delete process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS
            else process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS = previousBackoff
        }
    })

    it('keeps --resume available for the launch that actually captures the session id', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, [...RESUME_ARGS])

        try {
            // Simulate the reopen-then-idle-then-/compact repro: an
            // isolate-triggering message is already queued before the very
            // first claudeRemote() attempt ever runs.
            queue.pushIsolateAndClear('/compact', { permissionMode: 'default' }, 'local-1')
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.callCount).toBe(2)

            // The first attempt bailed out before Claude ever spawned - it
            // must not have consumed the one-time --resume flag.
            // The second attempt is the one that actually captures the
            // session, and it must still see --resume in claudeArgs.
            expect(harness.claudeArgsPerCall[1]).toEqual(['--resume', 'original-session-id'])
            expect(session.sessionId).toBe('captured-session-id')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('drops --resume when /clear discards the context before any launch reached Claude', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, [...RESUME_ARGS])

        try {
            // /clear is pushed as an isolate message exactly like /compact, so
            // it takes the same reopen-then-idle relaunch path. Unlike /compact
            // it must NOT keep the resume anchor alive: the user asked for the
            // context to be discarded, so the follow-up message has to start a
            // genuinely fresh Claude session rather than resume the cleared one.
            queue.pushIsolateAndClear('/clear', { permissionMode: 'default' }, 'local-1')
            queue.push('hello', { permissionMode: 'default' }, 'local-2')
            harness.switchAfterCall = 3
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            // 1st attempt: bails out (isolate message parked as pending).
            // 2nd attempt: runs /clear -> onSessionReset, still no spawn.
            // 3rd attempt: the follow-up message, which must start fresh.
            expect(harness.callCount).toBe(3)
            expect(harness.claudeArgsPerCall[2]).toBeUndefined()
            expect(session.claudeArgs).toBeUndefined()
        } finally {
            session.stopKeepAlive()
        }
    })

    it('regression: still consumes --resume once the very first attempt captures the session (no relaunch needed)', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, [...RESUME_ARGS])

        try {
            // Ordinary happy path: a normal (non-isolate) message is already
            // queued, so the very first claudeRemote() attempt captures the
            // session immediately - no relaunch/idle gap involved.
            queue.push('hello', { permissionMode: 'default' }, 'local-1')
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.callCount).toBe(1)
            expect(harness.claudeArgsPerCall[0]).toEqual(['--resume', 'original-session-id'])
            expect(session.sessionId).toBe('captured-session-id')
            // The one-time flag must not linger once it has actually been
            // consumed by a launch that captured the session id.
            expect(session.claudeArgs).toBeUndefined()
        } finally {
            session.stopKeepAlive()
        }
    })

    it('regression: fresh spawn with no --resume flag is unaffected', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)

        try {
            queue.push('hello', { permissionMode: 'default' }, 'local-1')
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.callCount).toBe(1)
            expect(harness.claudeArgsPerCall[0]).toBeUndefined()
            expect(session.sessionId).toBe('captured-session-id')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('sends an advertised $skill through Claude native slash invocation', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)

        try {
            session.setNativeSkillNames(['hapi'])
            expect(session.expandSkillReference('$unknown inspect')).toBe('$unknown inspect')
            expect(session.expandSkillReference('ask $hapi')).toBe('ask $hapi')
            queue.push('$hapi inspect', { permissionMode: 'default' }, 'local-1')
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.initialMessages).toEqual(['/hapi inspect'])
        } finally {
            session.stopKeepAlive()
        }
    })

    it('keeps an advertised $skill first when attachments are present', async () => {
        const client = createClientStub()
        const { session, queue } = createSession(client, undefined)

        try {
            session.setNativeSkillNames(['hapi'])
            const prompt = session.expandSkillReference(
                '$hapi inspect',
                '@C:\\Users\\Jane Doe\\input.txt'
            )
            queue.push(prompt, { permissionMode: 'default' }, 'local-1')
            harness.switchAfterCall = 1
            harness.triggerSwitch = () => {
                client.rpcHandlers.get(RPC_METHODS.Switch)?.()
            }

            await claudeRemoteLauncher(session as any)

            expect(harness.initialMessages).toEqual([
                '/hapi inspect\n\n@C:\\Users\\Jane Doe\\input.txt'
            ])
        } finally {
            session.stopKeepAlive()
        }
    })
})
