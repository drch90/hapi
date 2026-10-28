import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'
import type { SessionModel, SessionEffort } from '@/api/types'

type RunningSession = {
    model: SessionModel
    effort: SessionEffort
    permissionMode: string
    getModel: () => SessionModel
    getEffort: () => SessionEffort
    getPermissionMode: () => string
    setModel: (model: SessionModel) => void
    setEffort: (effort: SessionEffort) => void
    setPermissionMode: (mode: string) => void
    pushKeepAlive: () => void
    setNativeSkillNames: () => void
    expandSkillReference: (text: string) => string
    steerQueuedMessage: (localId: string) => Promise<{ steered: boolean; error?: string }>
}

const harness = vi.hoisted(() => ({
    handlers: new Map<string, (payload: unknown) => Promise<unknown>>(),
    receive: null as null | ((message: unknown, localId: string) => void),
    exercise: null as null | ((session: RunningSession, queue: MessageQueue2<EnhancedMode>) => Promise<void>),
    consumed: vi.fn(),
    events: vi.fn(),
    keepAlive: vi.fn(),
    loop: vi.fn(),
    steer: vi.fn(),
    beforeSessionReady: null as null | (() => void),
}))

vi.mock('@/ui/logger', () => ({ logger: {
    debug: vi.fn(), debugLargeJson: vi.fn(), infoDeveloper: vi.fn(), logFilePath: '/tmp/claude-model-test.log',
} }))
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: () => ({}) }))
vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: async () => ({
        api: {}, sessionInfo: { id: 'model-test' },
        session: {
            rpcHandlerManager: { registerHandler: (method: string, handler: (payload: unknown) => Promise<unknown>) => harness.handlers.set(method, handler) },
            updateMetadata: vi.fn(),
            onUserMessage: (handler: typeof harness.receive) => { harness.receive = handler },
            onCancelQueuedMessage: vi.fn(),
            sendSessionEvent: harness.events,
            emitMessagesConsumed: harness.consumed,
        },
    }),
    bootstrapExistingSession: vi.fn(),
}))
vi.mock('@/claude/loop', () => ({ loop: harness.loop }))
vi.mock('@/agent/runnerLifecycle', () => ({
    createModeChangeHandler: () => vi.fn(),
    setControlledByUser: vi.fn(),
    createRunnerLifecycle: () => ({
        registerProcessHandlers: vi.fn(), setSessionEndReason: vi.fn(),
        cleanupAndExit: vi.fn(), markCrash: vi.fn(), cleanup: vi.fn(),
    }),
}))
vi.mock('./registerKillSessionHandler', () => ({ registerKillSessionHandler: vi.fn() }))
vi.mock('@/agent/localHandoff', () => ({ registerLocalHandoffHandler: vi.fn() }))
vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: async () => ({ toolNames: [], url: 'http://127.0.0.1', stop: vi.fn() }),
    toClaudeAllowedHapiMcpTools: () => [],
}))
vi.mock('@/claude/utils/startHookServer', () => ({ startHookServer: async () => ({ port: 0, token: 'test', stop: vi.fn() }) }))
vi.mock('@/modules/common/hooks/generateHookSettings', () => ({ generateHookSettingsFile: () => '/tmp/unused-model-test-hooks.json', cleanupHookSettingsFile: vi.fn() }))
vi.mock('@/claude/sdk/metadataExtractor', () => ({
    extractSDKMetadata: async () => ({ slashCommands: ['model'] }),
    classifyClaudeSlashCatalog: () => ({ commands: ['model'], skills: [] }),
}))
vi.mock('@/modules/common/skills', () => ({ listSkills: async () => [] }))

import { runClaude } from './runClaude'

function send(text: string, localId: string, attachments?: unknown[]) {
    harness.receive!({ content: { type: 'text', text, ...(attachments ? { attachments } : {}) } }, localId)
}

beforeEach(() => {
    vi.clearAllMocks()
    harness.handlers.clear()
    harness.receive = null
    harness.beforeSessionReady = null
    harness.steer.mockResolvedValue({ steered: true })
    harness.loop.mockImplementation(async (options) => {
        const session: RunningSession = {
            model: options.model, effort: options.effort, permissionMode: 'default',
            getModel() { return this.model },
            getEffort() { return this.effort },
            getPermissionMode() { return this.permissionMode },
            setModel(model) { this.model = model },
            setEffort(effort) { this.effort = effort },
            setPermissionMode(mode) { this.permissionMode = mode },
            pushKeepAlive() { harness.keepAlive({ model: this.model, permissionMode: this.permissionMode }) },
            setNativeSkillNames() {},
            expandSkillReference(text) { return text },
            steerQueuedMessage(localId) {
                return harness.steer(localId, options.messageQueue.peekByLocalId(localId))
            },
        }
        harness.beforeSessionReady?.()
        options.onSessionReady(session)
        // Startup holds messages until both the session and catalog are ready.
        await new Promise<void>((resolve) => setImmediate(resolve))
        await harness.exercise!(session, options.messageQueue)
    })
})

describe('Claude /model persistence', () => {
    it('reserves explicit direct steer only after formatting and enqueueing the message', async () => {
        harness.exercise = async (_session, queue) => {
            send('ordinary follow-up', 'ordinary')
            expect(harness.steer).not.toHaveBeenCalled()
            harness.receive!({ content: { type: 'text', text: 'new direction' }, meta: { deliveryMode: 'steer' } }, 'guidance')
            expect(harness.steer).toHaveBeenCalledExactlyOnceWith('guidance', expect.objectContaining({
                localId: 'guidance', message: 'new direction', mode: expect.objectContaining({ permissionMode: 'default' })
            }))
            expect(queue.peekByLocalId('ordinary')).not.toBeNull()
            harness.receive!({ content: { type: 'text', text: '/model custom-model' }, meta: { deliveryMode: 'steer' } }, 'model')
            expect(harness.steer).toHaveBeenCalledOnce()
            expect(harness.consumed).toHaveBeenCalledWith(['model'])
        }
        await runClaude({ workingDirectory: '/tmp', startedBy: 'runner' })
    })

    it('downgrades steer intent received during initialization to ordinary queue delivery', async () => {
        harness.beforeSessionReady = () => {
            harness.receive!({ content: { type: 'text', text: 'startup guidance' }, meta: { deliveryMode: 'steer' } }, 'startup')
        }
        harness.exercise = async (_session, queue) => {
            expect(harness.steer).not.toHaveBeenCalled()
            expect(queue.peekByLocalId('startup')?.message).toBe('startup guidance')
        }
        await runClaude({ workingDirectory: '/tmp', startedBy: 'runner' })
    })

    it.each(['acceptEdits', 'plan', 'bypassPermissions'])('keeps a custom model when changing permission mode to %s', async (permissionMode) => {
        harness.exercise = async (session, queue) => {
            send('/model provider/custom-model', 'model-command')
            expect(session.model).toBe('provider/custom-model')
            expect(queue.size()).toBe(0)
            expect(harness.consumed).toHaveBeenCalledWith(['model-command'])
            expect(harness.keepAlive).toHaveBeenCalledWith({ model: 'provider/custom-model', permissionMode: 'default' })
            const applied = await harness.handlers.get(RPC_METHODS.SetSessionConfig)!({ permissionMode })
            expect(applied).toMatchObject({ applied: { model: 'provider/custom-model', permissionMode } })
            send('Continue after changing permissions', 'next-turn')
            const next = await queue.waitForMessagesAndGetAsString(new AbortController().signal)
            expect(next?.mode.model).toBe('provider/custom-model')
            expect(next?.mode.permissionMode).toBe(permissionMode)
        }
        await runClaude({ workingDirectory: '/tmp', startedBy: 'runner' })
    })

    it('explicitly resets a custom model and leaves a bare /model command available', async () => {
        harness.exercise = async (session, queue) => {
            send('/model custom:office:qwen:32b', 'select')
            send('/model default', 'reset')
            expect(session.model).toBeNull()
            send('/model', 'catalog')
            const next = await queue.waitForMessagesAndGetAsString(new AbortController().signal)
            expect(next?.message).toBe('/model')
            expect(next?.mode.model).toBeUndefined()
            expect(harness.events).toHaveBeenCalledWith({ type: 'message', message: 'Model changed to default' })
        }
        await runClaude({ workingDirectory: '/tmp', startedBy: 'runner' })
    })

    it('preserves an existing effort setting across model and permission changes', async () => {
        harness.exercise = async (session, queue) => {
            send('/model custom:model', 'select')
            await harness.handlers.get(RPC_METHODS.SetSessionConfig)!({ permissionMode: 'plan' })
            expect(session.effort).toBe('high')
            send('Continue', 'next-turn')
            const next = await queue.waitForMessagesAndGetAsString(new AbortController().signal)
            expect(next?.mode).toMatchObject({ model: 'custom:model', effort: 'high', permissionMode: 'plan' })
        }
        await runClaude({ workingDirectory: '/tmp', startedBy: 'runner', effort: 'high' })
    })
})
