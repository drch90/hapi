import React from 'react';
import { convertAgentMessage } from '@/agent/messageConverter';
import { createNativeSessionTitleMetadataSync } from '@/agent/nativeSessionTitle';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext } from '@/modules/common/remote/RemoteLauncherBase';
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { AgySession } from '../session';
import type { AgyMode } from '../types';
import { AgySteering, type AgySteerTarget } from '../steering';
import { normalizeAgyTool } from '../messages';
import { AgyIndeterminateDeliveryError, normalizeAgyInput } from './delivery';
import { createAgyProcess, type AgyProcess } from './nativeProcess';
import { AgyTranscript, AgyTranscriptCursor, matchesAgyReceipt, type AgyNativeStep, type AgyTranscriptSource } from './transcript';
import { AgyPtyPermissionHandler } from './permissionHandler';

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}

type Owner = {
    process: AgyProcess;
    key: string;
    setup: Promise<void>;
    retiring: boolean;
    retirement?: Promise<void>;
    transcript: AgyTranscriptSource | null;
    permissions: AgyPtyPermissionHandler | null;
    failure: Error | null;
};
type Delivery = {
    text: string;
    input: string;
    mode: string;
    baseline: number;
    receipt: ReturnType<typeof deferred>;
    submitted: boolean;
};
type Emission = { text?: string; thinking?: string; live?: boolean; sentAt: number; tool?: string; result?: string; error?: string };
type Turn = {
    prompt: string;
    input: string;
    localIds: string[];
    mode: AgyMode;
    owner: Owner | null;
    target: AgySteerTarget | null;
    cursor: AgyTranscriptCursor | null;
    baseline: number;
    submitted: boolean;
    acknowledged: boolean;
    stopped: boolean;
    finished: boolean;
    sawBusy: boolean;
    idleSince: number | null;
    pending: Delivery | null;
    receipts: Set<number>;
    emitted: Map<number, Emission>;
    startedAt: number;
    dispatchedAt: number | null;
    firstOutput: boolean;
};

/** Own one native TUI and read its durable trajectory. The terminal controls
 * focus/modes/decisions; only SQLite USER_INPUT records acknowledge messages. */
export class AgyPtyDriver extends RemoteLauncherBase {
    private readonly waitController = new AbortController();
    private readonly steering: AgySteering;
    private readonly syncTitle: (title: unknown) => void;
    private owner: Owner | null = null;
    private turn: Turn | null = null;
    private activeTurn: Promise<void> | null = null;
    private preparation: Promise<unknown> = Promise.resolve();

    constructor(private readonly session: AgySession, private readonly processFactory = createAgyProcess,
        private readonly transcriptFactory: (id: string) => AgyTranscriptSource = id => new AgyTranscript(id)) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.steering = new AgySteering(session);
        this.syncTitle = createNativeSessionTitleMetadataSync(session.client);
        session.setKillHandler(() => this.kill());
        session.steerQueuedMessage = localId => this.steering.steer(localId);
        session.applyConfig = async mode => {
            // A running turn and already queued messages keep their snapshots.
            if (!this.turn && !this.shouldExit) await this.prepare(mode);
        };
        session.client.updateAgentState(state => ({ ...state, steeringActive: false }));
    }

    launch() { return this.start({ onExit: () => this.kill() }); }
    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement { return React.createElement(RemoteModeDisplay, context); }
    protected getCurrentSessionId(): string | null { return this.session.sessionId; }

    private currentMode(): AgyMode {
        return this.session.getConfig();
    }

    private async retire(owner: Owner | null): Promise<void> {
        if (!owner) return;
        owner.retiring = true;
        if (this.owner === owner) this.steering.setTarget(null);
        owner.permissions?.close();
        this.turn?.pending?.receipt.reject(new AgyIndeterminateDeliveryError('Antigravity stopped before confirming guidance'));
        owner.retirement ??= (async () => {
            await owner.process.close();
            await owner.setup.catch(() => {});
            await owner.process.close();
            // An active turn drains final durable rows before closing its DB.
            if (this.turn?.owner !== owner) owner.transcript?.close();
        })();
        await owner.retirement;
        if (this.owner === owner) this.owner = null;
    }

    private prepare(mode: AgyMode): Promise<Owner> {
        const result = this.preparation.then(() => this.prepareExclusive(mode));
        this.preparation = result.catch(() => {});
        return result;
    }

    private async bindTranscript(owner: Owner): Promise<boolean> {
        if (owner.transcript) return true;
        const id = owner.process.sessionId;
        if (!id) return false;
        const transcript = this.transcriptFactory(id);
        owner.transcript = transcript;
        await transcript.maxIndex();
        if (owner.retiring || this.shouldExit) throw new Error('Antigravity startup cancelled');
        this.session.onSessionFound(id);
        owner.permissions = new AgyPtyPermissionHandler(this.session.client, owner.process, transcript,
            () => this.owner === owner && !owner.retiring && !owner.failure && this.turn?.owner === owner && !this.turn.stopped,
            () => this.stop(), error => { owner.failure = error; });
        if (transcript.title) this.syncTitle(await transcript.title());
        this.session.client.emitSessionReady();
        return true;
    }

    private async prepareExclusive(mode: AgyMode): Promise<Owner> {
        // Normal permission changes use native Shift+Tab. Model/effort and the
        // dangerous bypass flag require a new process for the same conversation.
        const key = JSON.stringify([mode.permissionMode === 'always-proceed', mode.model ?? null, mode.effort ?? null]);
        if (this.owner && (this.owner.key !== key || this.owner.process.failure || this.owner.failure || this.owner.retiring)) await this.retire(this.owner);
        if (this.shouldExit || this.turn?.stopped) throw new Error('Antigravity startup cancelled');
        if (this.owner) {
            await this.owner.setup;
            await this.owner.process.setMode(mode.permissionMode);
            return this.owner;
        }
        const process = this.processFactory(this.session.path, mode, this.session.sessionId);
        const owner: Owner = { process, key, setup: Promise.resolve(), retiring: false, transcript: null, permissions: null, failure: null };
        this.owner = owner;
        owner.setup = (async () => {
            await process.start();
            if (this.shouldExit || owner.retiring) throw new Error('Antigravity startup cancelled');
            // Resume has an ID already. A fresh idle TUI creates one only when
            // it receives the first message, so it can prewarm without a DB.
            await this.bindTranscript(owner);
        })();
        try { await owner.setup; } catch (error) { owner.failure = error instanceof Error ? error : new Error(String(error)); throw error; }
        return owner;
    }

    private acknowledge(turn: Turn): void {
        if (turn.acknowledged) return;
        turn.acknowledged = true;
        this.session.client.emitMessagesConsumed(turn.localIds);
        logger.debug('[agy] Native receipt', { latencyMs: Date.now() - (turn.dispatchedAt ?? turn.startedAt) });
    }

    private canSteer(turn: Turn): boolean {
        const owner = turn.owner;
        return this.turn === turn && turn.acknowledged && !turn.stopped && !turn.finished && Boolean(owner && !owner.retiring && !owner.failure
            && !owner.process.failure && owner.process.state.kind === 'prompt' && owner.process.state.busy && owner.process.state.editor === '');
    }

    private beginSteer(turn: Turn, text: string) {
        const owner = turn.owner!;
        const receipt = deferred();
        const delivery: Delivery = { text, input: normalizeAgyInput(text), mode: owner.process.state.mode ?? 'default', baseline: -1, receipt, submitted: false };
        if (!this.canSteer(turn) || turn.pending) throw new Error('Antigravity is not ready for guidance');
        turn.pending = delivery;
        const dispatched = owner.process.submit(delivery.input, true, async () => {
            if (!this.canSteer(turn)) throw new Error('The active Antigravity turn changed');
            delivery.baseline = await owner.transcript!.maxIndex();
        }).then(() => { delivery.submitted = true; }).catch(error => {
            receipt.reject(error instanceof Error ? error : new Error(String(error)));
            if (turn.pending === delivery) turn.pending = null;
            throw error;
        });
        return { dispatched, completed: receipt.promise };
    }

    private receive(turn: Turn, step: AgyNativeStep): void {
        if (turn.receipts.has(step.index) || step.index <= turn.baseline) return;
        if (!turn.acknowledged && matchesAgyReceipt(step, turn.input, turn.mode.permissionMode)) {
            turn.receipts.add(step.index);
            this.acknowledge(turn);
        } else {
            const delivery = turn.pending;
            if (!delivery?.submitted || step.index <= delivery.baseline || !matchesAgyReceipt(step, delivery.input, delivery.mode)) return;
            turn.receipts.add(step.index);
            if (turn.target) this.steering.acknowledge(turn.target, delivery.text);
            turn.pending = null;
            delivery.receipt.resolve();
        }
    }

    private emit(turn: Turn, step: AgyNativeStep, final = false): void {
        if (step.invalidated) return;
        const previous = turn.emitted.get(step.index) ?? { sentAt: 0 };
        const now = Date.now();
        const live = !final && !step.terminal;
        const streamId = `agy-${turn.owner!.process.sessionId}-${step.index}`;
        if (step.type === 15 && (!previous.sentAt || !live || step.text && !previous.text || step.thinking && !previous.thinking || now - previous.sentAt >= 200)) {
            if (step.text && (step.text !== previous.text || previous.live !== live)) {
                this.session.client.sendAgySessionMessage({ type: 'PLANNER_RESPONSE', id: `${streamId}-text`, content: step.text,
                    model: step.model || turn.owner!.process.model || undefined }, turn.owner!.process.sessionId ?? undefined);
                previous.text = step.text;
                if (!live) this.messageBuffer.addMessage(step.text, 'assistant');
            }
            if (step.thinking && (step.thinking !== previous.thinking || previous.live !== live)) {
                this.session.client.sendAgentMessage(convertAgentMessage({ type: 'reasoning', id: `${streamId}-thinking`, text: step.thinking, live }));
                previous.thinking = step.thinking;
            }
            if ((step.text || step.thinking) && !turn.firstOutput) {
                turn.firstOutput = true;
                logger.debug('[agy] First native output', { latencyMs: now - (turn.dispatchedAt ?? turn.startedAt) });
            }
            previous.sentAt = now;
            previous.live = live;
        }
        if (step.tool) {
            const tool = step.tool;
            const status = step.terminal ? step.failed ? 'failed' as const : 'completed' as const : step.status === 9 ? 'pending' as const : 'in_progress' as const;
            const call = normalizeAgyTool({ type: 'tool_call', id: tool.id, name: tool.name, input: tool.input, status,
                ...(tool.summary ? { title: tool.summary } : {}) });
            const key = JSON.stringify(call);
            if (previous.tool !== key) {
                this.session.client.sendAgentMessage(convertAgentMessage(call));
                previous.tool = key;
            }
            if (step.terminal) {
                const result = JSON.stringify([tool.output, step.failed]);
                if (previous.result !== result) {
                    this.session.client.sendAgentMessage(convertAgentMessage({ type: 'tool_result', id: tool.id,
                        output: tool.output || step.error, status: step.failed ? 'failed' : 'completed' }));
                    previous.result = result;
                }
            }
        } else if (step.error && previous.error !== step.error) {
            this.session.client.sendSessionEvent({ type: 'error', message: step.error });
            previous.error = step.error;
        }
        turn.emitted.set(step.index, previous);
    }

    private async refresh(turn: Turn, all = false): Promise<void> {
        await turn.owner!.process.refreshStatus();
        await turn.cursor!.refresh(all);
        for (const step of turn.cursor!.steps.values()) {
            this.receive(turn, step);
            this.emit(turn, step);
        }
        turn.owner!.permissions!.sync(turn.cursor!.steps.values());
        this.steering.setTarget(this.canSteer(turn) ? turn.target : null);
    }

    private async follow(turn: Turn): Promise<void> {
        const owner = turn.owner!;
        let blockedSince: number | null = null;
        let readFailureSince: number | null = null;
        while (!turn.stopped && !this.shouldExit) {
            if (owner.retiring || owner.failure || owner.process.failure) throw owner.failure ?? owner.process.failure ?? new Error('Antigravity stopped');
            try {
                await this.refresh(turn);
                readFailureSince = null;
            } catch (error) {
                if (!/SQLITE_BUSY|database is locked/.test(String(error))) throw error;
                readFailureSince ??= Date.now();
                if (Date.now() - readFailureSince > 3_000) throw error;
                await owner.process.waitForChange();
                continue;
            }
            const state = owner.process.state;
            // A very short response can finish between screen polls. Its new
            // planner step is also evidence that the native turn actually ran.
            if (state.busy || [...turn.cursor!.steps.values()].some(step => step.type === 15)) turn.sawBusy = true;
            const idle = state.kind === 'prompt' && !state.busy && state.editor === '';
            const waiting = [...turn.cursor!.steps.values()].some(step => step.permission);
            if (waiting && !owner.permissions!.pending) {
                blockedSince ??= Date.now();
                if (Date.now() - blockedSince > 10_000) throw new Error(`Antigravity requested a native interaction HAPI cannot display. Continue in a terminal with agy --conversation=${owner.process.sessionId}`);
            } else blockedSince = null;
            if (!turn.acknowledged && Date.now() - turn.dispatchedAt! > 30_000) {
                throw new AgyIndeterminateDeliveryError('Antigravity did not confirm message receipt; retry only after checking the conversation');
            }
            if (turn.acknowledged && turn.sawBusy && idle && turn.cursor!.settled && !owner.permissions!.pending) {
                turn.idleSince ??= Date.now();
                // Drain after a stable native idle paint, including in-place
                // final snapshots. A DONE tool alone never finishes the turn.
                if (Date.now() - turn.idleSince >= 150) {
                    await this.refresh(turn, true);
                    if (owner.process.state.kind === 'prompt' && !owner.process.state.busy && turn.cursor!.settled) {
                        turn.pending?.receipt.reject(new AgyIndeterminateDeliveryError('Antigravity became idle before confirming guidance'));
                        turn.pending = null;
                        turn.finished = true;
                        if (owner.transcript!.title) this.syncTitle(await owner.transcript!.title());
                        return;
                    }
                }
            } else turn.idleSince = null;
            await owner.process.waitForChange();
        }
    }

    private restore(turn: Turn): void {
        // Restore to the composer only. It must not be replayed automatically.
        if (!turn.acknowledged) {
            turn.acknowledged = true;
            this.session.client.emitMessagesConsumed(turn.localIds);
        }
        this.session.client.sendSessionEvent({ type: 'abort-restore', text: turn.prompt });
    }

    private async runTurn(prompt: string, localIds: string[], mode: AgyMode): Promise<void> {
        const turn: Turn = { prompt, input: prompt, localIds, mode, owner: null, target: null, cursor: null, baseline: -1, submitted: false,
            acknowledged: false, stopped: false, finished: false, sawBusy: false, idleSince: null, pending: null,
            receipts: new Set(), emitted: new Map(), startedAt: Date.now(), dispatchedAt: null, firstOutput: false };
        this.turn = turn;
        this.session.onThinkingChange(true);
        this.messageBuffer.addMessage(prompt, 'user');
        try {
            turn.input = normalizeAgyInput(prompt);
            if (/^\s*\/[a-z][-a-z]*(?:\s|$)/i.test(turn.input)) throw new Error('Use HAPI session controls for modes and models; native terminal slash commands require agy in a terminal');
            const owner = await this.prepare(mode);
            if (turn.stopped || this.shouldExit) return;
            turn.owner = owner;
            turn.target = { isActive: () => this.canSteer(turn), send: text => this.beginSteer(turn, text) };
            await owner.process.submit(turn.input, false, async () => {
                turn.baseline = owner.transcript ? await owner.transcript.maxIndex() : -1;
                if (owner.transcript) turn.cursor = new AgyTranscriptCursor(owner.transcript, turn.baseline + 1);
            });
            turn.submitted = true;
            turn.dispatchedAt = Date.now();
            logger.debug('[agy] Native submit', { preparationMs: turn.dispatchedAt - turn.startedAt });
            while (!owner.transcript && !turn.stopped && !this.shouldExit) {
                if (owner.retiring || owner.failure || owner.process.failure) throw owner.failure ?? owner.process.failure ?? new Error('Antigravity stopped');
                await owner.process.refreshStatus();
                if (await this.bindTranscript(owner)) break;
                if (Date.now() - turn.dispatchedAt > 30_000) throw new AgyIndeterminateDeliveryError('Antigravity did not confirm the new conversation after submission');
                await owner.process.waitForChange();
            }
            if (turn.stopped || this.shouldExit) return;
            turn.cursor ??= new AgyTranscriptCursor(owner.transcript!, turn.baseline + 1);
            await this.follow(turn);
        } catch (error) {
            if (!turn.stopped) {
                this.session.client.sendSessionEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) });
                if (!turn.acknowledged) {
                    if (turn.submitted || error instanceof AgyIndeterminateDeliveryError) this.session.client.emitSteerIndeterminate(turn.localIds);
                    else this.restore(turn);
                }
            }
            await this.retire(this.owner);
        } finally {
            this.steering.setTarget(null);
            turn.pending?.receipt.reject(new AgyIndeterminateDeliveryError('Antigravity turn ended before confirming guidance'));
            turn.pending = null;
            await this.steering.drain();
            if (turn.cursor) {
                try { await turn.cursor.refresh(true); } catch (error) { logger.debug('[agy] Final trajectory read failed', error); }
            }
            for (const step of turn.cursor?.steps.values() ?? []) {
                if (step.tool && !step.terminal && turn.owner?.retiring) {
                    const reason = turn.stopped ? 'Antigravity turn stopped' : 'Antigravity process ended before this tool completed';
                    this.emit(turn, { ...step, terminal: true, failed: true, status: 6, error: reason,
                        tool: { ...step.tool, output: step.tool.output || reason } }, true);
                } else this.emit(turn, step, true);
            }
            turn.owner?.permissions?.cancelAll('Antigravity turn finished');
            if (turn.owner?.retiring) turn.owner.transcript?.close();
            if (this.turn === turn) this.turn = null;
            this.session.onThinkingChange(false);
        }
        if (!this.shouldExit && !turn.stopped && this.session.queue.size() === 0) this.session.client.sendSessionEvent({ type: 'ready' });
    }

    private async stop(): Promise<void> {
        this.steering.setTarget(null);
        const turn = this.turn;
        const completion = this.activeTurn;
        if (turn && !turn.stopped) {
            turn.stopped = true;
            if (!turn.finished) this.restore(turn);
        }
        await this.retire(this.owner);
        await this.steering.drain();
        // Keep the API client alive through final output and thinking cleanup.
        await completion;
    }

    async kill(): Promise<void> {
        this.shouldExit = true;
        this.exitReason = 'exit';
        this.waitController.abort();
        await this.stop();
    }

    protected async runMainLoop(): Promise<void> {
        const rpc = this.session.client.rpcHandlerManager;
        this.setupAbortHandlers(rpc, { onAbort: () => this.stop(), onSwitch: () => {} });
        rpc.registerHandler(RPC_METHODS.SteerQueuedMessage, (data: { localId?: string } | null) => this.steering.steer(typeof data?.localId === 'string' ? data.localId : ''));
        // Warm the authenticated native process when the HAPI session opens.
        try { await this.prepare(this.currentMode()); } catch (error) {
            if (!this.shouldExit) this.session.client.sendSessionEvent({ type: 'error', message: String(error) });
            await this.retire(this.owner);
        }
        while (!this.shouldExit) {
            const batch = await this.session.queue.waitForMessagesAndGetAsString(this.waitController.signal);
            if (!batch) break;
            const ids = (batch.items ?? []).map(item => item.localId).filter((id): id is string => Boolean(id));
            this.activeTurn = this.runTurn(batch.message, ids, batch.mode);
            try { await this.activeTurn; } finally { this.activeTurn = null; }
        }
    }

    protected async cleanup(): Promise<void> {
        this.session.steerQueuedMessage = null;
        this.session.applyConfig = null;
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, () => ({ steered: false, error: 'Antigravity session ended' }));
        await this.stop();
    }
}

export async function agyPtyDriver(session: AgySession): Promise<'switch' | 'exit'> {
    return new AgyPtyDriver(session).launch();
}
