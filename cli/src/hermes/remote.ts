import React from 'react'
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle'
import { convertAgentMessage } from '@/agent/messageConverter'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge'
import { RemoteLauncherBase, type RemoteLauncherDisplayContext } from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { RPC_METHODS, type HermesPermissionMode } from '@hapi/protocol'
import { createHermesBackend } from './backend'
import { HermesPermissionHandler } from './permissionHandler'
import type { HermesSession } from './session'
import { confirmedHermesModel, hermesModels, resolveHermesModel } from './models'
import { hermesCommands, isHermesMutation, parseHermesCommand } from './commands'
import { HermesSteering } from './steering'
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import type { AgentSessionConfig } from '@/agent/types'

export class HermesRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createHermesBackend> | null = null
    private permissions: HermesPermissionHandler | null = null
    private bridge: { stop: () => void } | null = null
    private waitController = new AbortController()
    private failure: Error | null = null
    private closing = false
    private cleanupPromise: Promise<void> | null = null
    private operations: Promise<unknown> = Promise.resolve()
    private steering: HermesSteering | null = null
    private promptInFlight = false
    private turnPending = false
    private settingsPending = 0
    private modelSyncError: string | null = null
    private sessionConfig: AgentSessionConfig | null = null

    constructor(private readonly session: HermesSession, private readonly onReady: () => Promise<void>) {
        super(process.env.DEBUG ? session.logPath : undefined)
    }

    launch() { return this.start({ onExit: () => this.kill() }) }

    receive(text: string, localId?: string): void {
        const command = parseHermesCommand(text)
        const reject = (message: string) => {
            this.reply(message)
            if (localId) this.session.client.emitMessagesConsumed([localId], { clearQueuedThinkingGrace: true })
        }
        if (command) {
            if (!hermesCommands(this.backend?.getAvailableCommands(this.session.sessionId ?? '')).some(row => row.name === command.name)) {
                reject(`Unsupported Hermes command: /${command.name}. Use /help.`)
                return
            }
            if (isHermesMutation(command.name) && this.settingsBusy()) {
                reject(`Wait for Hermes to become idle before using /${command.name}.`)
                return
            }
            if (command.name === 'steer') {
                if (!command.args) { reject('Usage: /steer <guidance>'); return }
                if (this.promptInFlight && this.steering) {
                    if (!localId) { reject('A message ID is required for steer. Please resend from HAPI.'); return }
                    this.session.queue.pushIsolated(text, {}, localId)
                    void this.steering.steer(localId).then(result => { if (!result.steered) this.reply(result.error ?? 'Steer failed') })
                    return
                }
            }
            this.session.queue.pushIsolated(text, {}, localId)
        } else this.session.queue.push(text, {}, localId)
    }

    private reply(message: string): void {
        this.session.client.sendAgentMessage({ type: 'message', message })
        this.messageBuffer.addMessage(message, 'assistant')
    }

    private settingsBusy(): boolean {
        return this.session.thinking || this.turnPending || this.settingsPending > 0
            || this.session.queue.size() > 0 || this.steering?.busy === true
    }

    private async refreshModels(acceptedChoice = this.session.getModel()): Promise<void> {
        if (!this.backend || !this.session.sessionId || !this.sessionConfig) throw new Error('Hermes is still starting')
        await this.backend.suppressUpdatesDuring(() => this.backend!.loadSession({ ...this.sessionConfig!, sessionId: this.session.sessionId! }))
        const models = this.backend.getSessionModelsMetadata(this.session.sessionId)
        if (!models?.currentModelId) throw new Error('Hermes did not confirm its current model')
        this.session.setModel(confirmedHermesModel(models, acceptedChoice))
        this.modelSyncError = null
        this.session.pushKeepAlive()
    }

    private async applyModel(input: string): Promise<void> {
        const backend = this.backend!
        const id = this.session.sessionId!
        const model = resolveHermesModel(input, backend.getSessionModelsMetadata(id)?.availableModels ?? [])
        try {
            await backend.setModel(id, model, { flavor: 'hermes' })
        } catch (error) {
            if (isAcpIndeterminateError(error)) {
                this.modelSyncError = 'Model switch outcome is unknown. Refresh the model catalog before continuing.'
                this.session.setModel(null)
                this.session.pushKeepAlive()
            }
            throw error
        }
        try { await this.refreshModels(model) } catch {
            this.session.setModel(null)
            this.session.pushKeepAlive()
            this.modelSyncError = 'Hermes switched the model, but its current state could not be refreshed. Refresh the model catalog.'
            throw new Error(this.modelSyncError)
        }
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, { ...context, agentLabel: 'Hermes' })
    }

    private exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operations.then(async () => {
            if (this.shouldExit || this.failure) throw this.failure ?? new Error('Hermes session ended')
            return await operation()
        })
        this.operations = result.catch(() => {})
        return result
    }

    protected async runMainLoop(): Promise<void> {
        const { session } = this
        const backend = createHermesBackend(error => {
            if (this.closing) return
            this.failure = error
            this.waitController.abort()
        })
        this.backend = backend
        const publishCommands = () => session.client.updateMetadata(metadata => ({ ...metadata,
            slashCommands: hermesCommands(backend.getAvailableCommands(session.sessionId ?? '')).map(command => command.name) }))
        backend.setAvailableCommandsListener(() => publishCommands())
        registerAcpSessionTitleSync(backend, session.client)
        backend.setUsageUpdateListener(message => {
            const converted = convertAgentMessage(message)
            if (converted) session.client.sendAgentMessage(converted)
        })
        backend.onStderrError(error => session.client.sendSessionEvent({ type: 'message', message: error.message }))
        const bridge = await buildHapiMcpBridge(session.client, { enableChangeTitle: false })
        this.bridge = bridge.server
        if (this.shouldExit) { bridge.server.stop(); throw new Error('Hermes startup canceled') }
        this.permissions = new HermesPermissionHandler(session.client, backend)
        await backend.initialize()
        if (!backend.supportsLoadSession()) throw new Error('This Hermes build does not support persistent ACP sessions. Upgrade Hermes.')
        const config = { cwd: session.path, mcpServers: Object.entries(bridge.mcpServers).map(([name, server]) => ({
            name, command: server.command, args: server.args ?? [],
            env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
        })) }
        this.sessionConfig = config
        const id = session.sessionId
            ? await backend.suppressUpdatesDuring(() => backend.loadSession({ ...config, sessionId: session.sessionId! }))
            : await backend.newSession(config)
        if (this.shouldExit || this.failure) throw this.failure ?? new Error('Hermes startup canceled')
        session.onSessionFound(id)
        const initialModel = session.getModel()
        if (initialModel && initialModel !== 'auto') await this.applyModel(initialModel)
        if (!initialModel || initialModel === 'auto') {
            session.setModel(backend.getSessionModelsMetadata(id)?.currentModelId ?? null)
        }
        await backend.setMode(id, session.getPermissionMode() === 'acceptEdits' ? 'accept_edits' : 'default')
        session.pushKeepAlive()

        publishCommands()
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListSlashCommands, async () => ({
            success: true, commands: hermesCommands(backend.getAvailableCommands(id))
        }))
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListHermesModels, async (data: { refresh?: boolean } | null) => {
            if (data?.refresh) {
                if (this.settingsBusy()) return { ...hermesModels(backend.getSessionModelsMetadata(id)), success: false, error: 'Wait for Hermes to become idle before refreshing models' }
                this.settingsPending++
                try { await this.exclusive(() => this.refreshModels()) }
                finally { this.settingsPending-- }
            }
            return { ...hermesModels(backend.getSessionModelsMetadata(id)), currentModelId: session.getModel() ?? null,
                ...(this.modelSyncError ? { success: false, error: this.modelSyncError } : {}) }
        })
        registerSessionConfigRpc<HermesPermissionMode>({
            rpcHandlerManager: session.client.rpcHandlerManager,
            flavor: 'hermes', modelMode: 'nullable',
            onApply: config => {
                // Do not leave an unacknowledged config change queued behind a long
                // turn after the caller's RPC has timed out. Changes are idle-only.
                if (this.settingsBusy()) throw new Error('Wait for the Hermes turn to finish before changing settings')
                this.settingsPending++
                return this.exclusive(async () => {
                    if (config.model !== undefined) {
                        if (!config.model || config.model === 'auto') throw new Error('Select a Hermes model from the session catalog')
                        await this.applyModel(config.model)
                    }
                    if (config.permissionMode !== undefined) {
                        await backend.setMode(id, config.permissionMode === 'acceptEdits' ? 'accept_edits' : 'default')
                        session.setPermissionMode(config.permissionMode)
                        session.pushKeepAlive()
                    }
                }).finally(() => { this.settingsPending-- })
            }
        })
        const supportsSteer = () => hermesCommands(backend.getAvailableCommands(id)).some(command => command.name === 'steer')
        this.steering = new HermesSteering(session, backend, () => this.promptInFlight && supportsSteer() && !this.shouldExit && !this.failure)
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async (data: { localId?: string } | null) =>
            this.steering!.steer(typeof data?.localId === 'string' ? data.localId : ''))
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, () => this.abort())
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.Switch, () => { throw new Error('Hermes sessions are controlled from HAPI Web') })
        await session.client.flush()
        if (this.shouldExit || this.failure) throw this.failure ?? new Error('Hermes startup canceled')
        await this.onReady()
        session.client.sendSessionEvent({ type: 'ready' })

        while (!this.shouldExit && !this.failure) {
            const batch = await session.queue.waitForMessagesAndGetAsString(this.waitController.signal)
            if (!batch) break
            this.turnPending = true
            this.messageBuffer.addMessage(batch.message, 'user')
            await this.exclusive(async () => {
                const command = parseHermesCommand(batch.message)
                session.onThinkingChange(true)
                try {
                    if (command && !hermesCommands(backend.getAvailableCommands(id)).some(row => row.name === command.name)) {
                        this.reply(`Unsupported Hermes command: /${command.name}. Use /help.`)
                        return
                    }
                    if (command?.name === 'help') {
                        this.reply(hermesCommands(backend.getAvailableCommands(id)).map(row => `/${row.name} — ${row.description}`).join('\n'))
                        return
                    }
                    if (command?.name === 'model') {
                        if (command.args) await this.applyModel(command.args)
                        this.reply(`Current model: ${session.getModel() ?? 'unknown'}${this.modelSyncError ? `\n${this.modelSyncError}` : ''}`)
                        return
                    }
                    this.promptInFlight = !command || command.name === 'steer'
                    session.client.updateAgentState(current => ({ ...current, steeringActive: this.promptInFlight && supportsSteer() }))
                    const prompt = command?.name === 'steer' ? command.args
                        : command ? `/${command.name}${command.args ? ` ${command.args}` : ''}` : batch.message
                    await backend.prompt(id, [{ type: 'text', text: prompt }], message => {
                        if (message.type === 'tool_result') void this.permissions?.onToolCompleted(message.id)
                        const converted = convertAgentMessage(message, session.getModel() ?? undefined)
                        if (converted) session.client.sendAgentMessage(converted)
                        if (message.type === 'text') this.messageBuffer.addMessage(message.text, 'assistant')
                    })
                } catch (error) {
                    if (this.failure) throw this.failure
                    if (!this.shouldExit) session.client.sendSessionEvent({ type: 'message', message: `Hermes: ${error instanceof Error ? error.message : String(error)}` })
                } finally {
                    this.promptInFlight = false
                    await this.steering?.drain()
                    session.client.updateAgentState(current => ({ ...current, steeringActive: false }))
                    await this.permissions?.cancelAll('Turn finished')
                    session.onThinkingChange(false)
                    this.turnPending = false
                    if (!this.shouldExit && !this.failure && session.queue.size() === 0) session.client.sendSessionEvent({ type: 'ready' })
                }
            })
        }
        if (this.failure) throw this.failure
    }

    async abort(): Promise<void> {
        this.promptInFlight = false
        this.session.queue.reset({ preserveDispatchingReservations: true })
        await this.permissions?.cancelAll('Turn canceled')
        if (this.session.sessionId) await this.backend?.cancelPrompt(this.session.sessionId)
    }

    async kill(): Promise<void> {
        this.shouldExit = true
        this.waitController.abort()
        await this.cleanup()
    }

    protected cleanup(): Promise<void> {
        if (this.cleanupPromise) return this.cleanupPromise
        this.closing = true
        this.cleanupPromise = (async () => {
            try { await this.abort() } finally {
                try { await this.backend?.disconnect() } finally { this.bridge?.stop() }
            }
        })()
        return this.cleanupPromise
    }
}
