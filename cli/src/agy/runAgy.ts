import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { agyLoop } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { AgyMode, PermissionMode } from './types';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createModeChangeHandler, createRunnerLifecycle } from '@/agent/runnerLifecycle';
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import type { SessionEffort, SessionModel } from '@/api/types';
import { splitAgyModelSelection } from '@hapi/protocol';
import { listAgyModels } from '@/modules/common/agyModels';
import { normalizeAgyModelSelection } from './utils/agyModelSelection';
import { formatAgyConfig, resolveAgyCommand } from './commands';
import type { AgySession } from './session';

export async function runAgy(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PermissionMode;
    model?: string;
    effort?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    /** Fresh machine-spawn stub (`--hapi-session-id`); adopt via bootstrapSession. */
    reservedSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[agy] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}`);

    // HAPI owns the native PTY; the web is the user-facing control surface.
    const startingMode: 'local' | 'remote' = opts.startingMode ?? 'remote';

    const initialState: AgentState = {
        controlledByUser: false,
        startingMode,
        steeringActive: false,
    };

    const initialModel = opts.model ?? null;

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'agy',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'agy',
            startedBy,
            workingDirectory,
            tag: `__hapi_agy_${randomUUID()}`,
            agentState: initialState,
            model: initialModel ?? undefined,
            effort: opts.effort,
            reservedSessionId: opts.reservedSessionId
        });
    const { api, session } = bootstrap;

    const messageQueue = new MessageQueue2<AgyMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        effort: mode.effort,
    }));

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'request-review';
    let sessionModel: SessionModel = initialModel;
    let sessionEffort: SessionEffort = opts.effort ?? null;

    const sessionWrapperRef: { current: AgySession | null } = { current: null };
    const pendingInput = new Set<string>();
    const cancelledInput = new Set<string>();

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'agy',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive(),
        onBeforeClose: () => sessionWrapperRef.current?.kill(),
        onAfterClose: () => undefined,
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit, session);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    let crashed = false;

    try {
        // Bootstrap must report to the runner before a potentially slow catalog
        // probe. ApiSessionClient buffers early messages until onUserMessage is
        // registered below, after the launch selection has been normalized.
        const initialized = (async () => {
            const catalog = splitAgyModelSelection(initialModel).model
                ? await listAgyModels()
                : undefined;
            const selection = normalizeAgyModelSelection(initialModel, opts.effort, catalog?.availableModels ?? []);
            sessionModel = selection.model;
            sessionEffort = selection.effort;
        })();

        const syncSessionMode = () => {
            const sessionInstance = sessionWrapperRef.current;
            if (!sessionInstance) return;
            sessionInstance.setPermissionMode(currentPermissionMode);
            sessionInstance.setModel(sessionModel);
            sessionInstance.setEffort(sessionEffort);
            sessionInstance.pushKeepAlive();
            logger.debug(`[agy] Synced session config: permissionMode=${currentPermissionMode}, model=${sessionModel ?? '(default)'}`);
        };

        session.onCancelQueuedMessage((localId) => {
            const removed = messageQueue.cancelByLocalId(localId) || pendingInput.has(localId);
            if (pendingInput.has(localId)) cancelledInput.add(localId);
            logger.debug(`[agy] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found'}`);
            return removed;
        });
        session.onRetryQueuedMessage(localId => messageQueue.releaseIndeterminateReservation(localId));

        let configSerial: Promise<unknown> = Promise.resolve();
        const applyConfig = (config: Partial<AgyMode>) => {
            const result = configSerial.then(async () => {
                // A config request received during startup must apply after the
                // initial selection, rather than be overwritten when probing ends.
                await initialized;
                let selection;
                if (config.model !== undefined || config.effort !== undefined) {
                    const models = await listAgyModels();
                    const model = config.model === undefined ? sessionModel : config.model;
                    const effort = config.effort !== undefined
                        ? config.effort
                        : config.model !== undefined && splitAgyModelSelection(model).effort
                            ? undefined
                            : sessionEffort;
                    selection = normalizeAgyModelSelection(model, effort, models.availableModels ?? []);
                }
                const nextMode: AgyMode = { permissionMode: config.permissionMode ?? currentPermissionMode,
                    model: selection ? selection.model : sessionModel, effort: selection ? selection.effort : sessionEffort };
                await sessionWrapperRef.current?.applyConfig?.(nextMode);
                currentPermissionMode = nextMode.permissionMode;
                if (selection) {
                    sessionModel = selection.model;
                    sessionEffort = selection.effort;
                }
                syncSessionMode();
                return selection;
            });
            configSerial = result.catch(() => {});
            return result;
        };
        registerSessionConfigRpc<PermissionMode>({
            rpcHandlerManager: session.rpcHandlerManager,
            flavor: 'agy',
            modelMode: 'nullable',
            effortMode: 'nullable',
            onApply: applyConfig,
        });

        await initialized;

        // A configuration command is a barrier for later input: a following
        // prompt snapshots the new selection, while earlier queued work keeps
        // its original selection. Native operations still occupy their FIFO slot.
        let inputSerial = Promise.resolve();
        let pendingConfigCommands = 0;
        let pendingInputs = 0;
        session.onUserMessage((message, localId) => {
            const command = resolveAgyCommand(message.content.text);
            const receivedText = command ? message.content.text : formatMessageWithAttachments(message.content.text, message.content.attachments);
            const afterConfigCommand = pendingConfigCommands > 0;
            const receivedMode: AgyMode = { permissionMode: currentPermissionMode, model: sessionModel, effort: sessionEffort };
            const enqueue = (text: string, mode: AgyMode) => {
                if (command) messageQueue.pushIsolated(text, mode, localId);
                else messageQueue.push(text, mode, localId);
                if (!command && message.meta?.deliveryMode === 'steer' && localId) {
                    void sessionWrapperRef.current?.steerQueuedMessage?.(localId).then(result => {
                        if (!result.steered && result.error) session.sendSessionEvent({ type: 'message', message: `Antigravity steer: ${result.error}` });
                    });
                }
            };
            // Keep ordinary sends and live Steer synchronous when no earlier
            // configuration command is waiting on its native/catalog result.
            if (command?.kind !== 'config' && pendingInputs === 0) {
                enqueue(receivedText, receivedMode);
                return;
            }
            if (command?.kind === 'config') pendingConfigCommands++;
            pendingInputs++;
            if (localId) pendingInput.add(localId);
            inputSerial = inputSerial.then(async () => {
                if (localId && cancelledInput.has(localId)) return;
                // Once execution starts, cancellation must not claim that a
                // native configuration change was removed from the queue.
                if (localId) pendingInput.delete(localId);
                let text = receivedText;
                if (command?.kind === 'config') {
                    await applyConfig(command.updates);
                    if (!command.prompt) {
                        if (localId) session.emitMessagesConsumed([localId], { clearQueuedThinkingGrace: true });
                        session.sendAgentMessage({ type: 'message', message: formatAgyConfig({ permissionMode: currentPermissionMode, model: sessionModel, effort: sessionEffort }) });
                        return;
                    }
                    text = formatMessageWithAttachments(command.prompt, message.content.attachments);
                }
                const mode: AgyMode = afterConfigCommand || command?.kind === 'config'
                    ? { permissionMode: currentPermissionMode, model: sessionModel, effort: sessionEffort }
                    : receivedMode;
                if (localId && cancelledInput.has(localId)) return;
                enqueue(text, mode);
            }).catch(error => {
                if (localId) session.emitMessagesConsumed([localId], { clearQueuedThinkingGrace: true });
                session.sendSessionEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) });
            }).finally(() => {
                if (command?.kind === 'config') pendingConfigCommands--;
                pendingInputs--;
                if (localId) { pendingInput.delete(localId); cancelledInput.delete(localId); }
            });
        });

        await agyLoop({
            path: workingDirectory,
            startingMode,
            startedBy,
            messageQueue,
            session,
            api,
            permissionMode: currentPermissionMode,
            model: sessionModel ?? undefined,
            effort: sessionEffort,
            resumeSessionId: opts.resumeSessionId,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
        await inputSerial;
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        logger.debug('[agy] Loop error:', error);
    } finally {
        if (!crashed) {
            lifecycle.setSessionEndReason('completed');
        }
        await lifecycle.cleanupAndExit();
    }
}
