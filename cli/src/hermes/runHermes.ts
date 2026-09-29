import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { notifyRunnerSessionStarted } from '@/runner/controlClient'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { logger } from '@/ui/logger'
import type { HermesPermissionMode } from '@hapi/protocol'
import { HermesSession, type HermesMode } from './session'
import { HermesRemoteLauncher } from './remote'

export async function runHermes(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'remote'
    existingSessionId?: string
    resumeSessionId?: string
    workingDirectory?: string
    model?: string
    permissionMode?: HermesPermissionMode
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd()
    const startedBy = opts.startedBy ?? 'terminal'
    const common = { flavor: 'hermes', startedBy, workingDirectory, reportStarted: false }
    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({ ...common, sessionId: opts.existingSessionId })
        : await bootstrapSession({ ...common, agentState: { controlledByUser: false, startingMode: 'remote' } })
    const { session, sessionInfo } = bootstrap
    setControlledByUser(session, 'remote')
    session.updateAgentState(current => ({
        ...current, startingMode: 'remote', requests: {},
        completedRequests: {
            ...current.completedRequests,
            ...Object.fromEntries(Object.entries(current.requests ?? {}).map(([id, request]) => [id, {
                ...request, completedAt: Date.now(), status: 'canceled' as const, reason: 'Hermes session restarted'
            }]))
        }
    }))
    const queue = new MessageQueue2<HermesMode>(() => 'hermes')
    const hermes = new HermesSession({
        api: bootstrap.api, client: session, path: workingDirectory, logPath: logger.getLogPath(),
        sessionId: opts.resumeSessionId ?? bootstrap.metadata.hermesSessionId ?? null,
        messageQueue: queue,
        permissionMode: opts.permissionMode ?? (sessionInfo.permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default'),
        model: opts.model ?? sessionInfo.model
    })
    session.onCancelQueuedMessage(localId => queue.cancelByLocalId(localId))
    session.onRetryQueuedMessage(localId => queue.releaseIndeterminateReservation(localId))
    const launcher = new HermesRemoteLauncher(hermes, async () => {
        try {
            const result = await notifyRunnerSessionStarted(sessionInfo.id, { ...bootstrap.metadata, hermesSessionId: hermes.sessionId! })
            if (startedBy === 'runner' && result?.error) throw new Error(result.error)
        } catch (error) {
            if (startedBy === 'runner') throw error
            logger.debug('[hermes] No runner to notify', error)
        }
    })
    const lifecycle = createRunnerLifecycle({
        session, logTag: 'hermes', stopKeepAlive: () => hermes.stopKeepAlive(), onBeforeClose: () => launcher.kill()
    })
    session.onUserMessage((message, localId) => launcher.receive(formatMessageWithAttachments(message.content.text, message.content.attachments), localId))
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle)
    try {
        await launcher.launch()
        lifecycle.setSessionEndReason('completed')
    } catch (error) {
        session.sendSessionEvent({ type: 'message', message: `Hermes session failed: ${error instanceof Error ? error.message : String(error)}` })
        lifecycle.markCrash(error)
    } finally {
        await lifecycle.cleanupAndExit()
    }
}
