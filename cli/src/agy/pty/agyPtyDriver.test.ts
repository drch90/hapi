import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgyPtyDriver } from './agyPtyDriver';
import { AgySession } from '../session';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { AgentState } from '@/api/types';
import type { AgyMode } from '../types';
import type { AgyProcess } from './nativeProcess';
import type { AgyNativeStep } from './transcript';
import type { AgyTerminalState } from './terminalState';
import { AgyIndeterminateDeliveryError } from './delivery';
import { parseAgyNativeStatus } from './nativeStatus';

const MODE: AgyMode = { permissionMode: 'request-review' };
const ID = '42c2e6b6-efca-4b44-85bb-746e6ef993ad';
const sleep = (ms = 2) => new Promise<void>(resolve => setTimeout(resolve, ms));
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 3_000, interval: 5 });

function step(index: number, data: Partial<AgyNativeStep> = {}): AgyNativeStep {
    return { index, type: 15, status: 3, terminal: true, failed: false, invalidated: false,
        createdAt: 0, executionId: 'execution', userText: '', interrupting: false, text: '', thinking: '', messageId: '', model: '', error: '', ...data };
}

class MemoryTranscript {
    rows: AgyNativeStep[] = [];
    maxIndex = vi.fn(async () => this.rows.at(-1)?.index ?? -1);
    read = vi.fn(async (from: number) => this.rows.filter(row => row.index >= from).slice(0, 512));
    close = vi.fn();
    append(data: Partial<AgyNativeStep>) { const row = step(this.rows.length, data); this.rows.push(row); return row.index; }
    update(index: number, data: Partial<AgyNativeStep>) { this.rows[index] = { ...this.rows[index]!, ...data }; }
}

class FakeProcess implements AgyProcess {
    sessionId: string | null;
    model: string | null = 'Native model';
    failure: Error | null = null;
    revision = 1;
    nativeStatus = parseAgyNativeStatus('{"agent_state":"idle"}');
    state: AgyTerminalState = { kind: 'prompt', busy: false, mode: 'default', editor: '', footer: '? for shortcuts', lines: [] };
    readonly inputs: Array<{ text: string; steer: boolean }> = [];
    readonly start = vi.fn(async () => {});
    readonly refreshStatus = vi.fn(async () => {});
    readonly compact = vi.fn(async () => 'Conversation compacted.');
    readonly close = vi.fn(async () => { this.failure = new Error('Native stopped'); });
    readonly waitForChange = async () => sleep();
    readonly setMode = vi.fn(async (mode: AgyMode['permissionMode']) => { this.state.mode = mode === 'auto' || mode === 'plan' ? mode : 'default'; });
    readonly submit = vi.fn(async (text: string, steer: boolean, before: () => Promise<void>) => {
        await before();
        this.inputs.push({ text, steer });
        this.sessionId ??= ID;
        this.state = { ...this.state, busy: true, editor: '' };
    });
    readonly respond = vi.fn(async (_menu: unknown, _approved: boolean, verify: () => Promise<boolean>) => {
        if (!await verify()) throw new Error('Stale approval');
    });
    constructor(id: string | null) { this.sessionId = id; }
}

const cleanup: Array<() => Promise<void>> = [];
function harness(options: { fresh?: boolean; configure?: (native: FakeProcess) => void; transcript?: MemoryTranscript } = {}) {
    let state: AgentState = {};
    const handlers = new Map<string, (data?: any) => any>();
    const client = {
        updateAgentState: vi.fn(fn => { state = fn(state); }),
        setSteerDeliveryState: vi.fn(async () => true), emitSteerIndeterminate: vi.fn(), emitMessagesConsumed: vi.fn(),
        emitSessionReady: vi.fn(), sendAgentMessage: vi.fn(), sendAgySessionMessage: vi.fn(), sendSessionEvent: vi.fn(),
        updateMetadata: vi.fn(), getMetadata: () => ({}), keepAlive: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn((name, handler) => handlers.set(name, handler)) },
    };
    const queue = new MessageQueue2<AgyMode>(mode => JSON.stringify(mode));
    const session = new AgySession({ api: {} as never, client: client as never, path: '/tmp', logPath: '/tmp/agy-native-test.log',
        sessionId: options.fresh ? null : ID, messageQueue: queue, onModeChange: () => {}, startedBy: 'runner', permissionMode: 'request-review' });
    const transcript = options.transcript ?? new MemoryTranscript();
    const natives: FakeProcess[] = [];
    const factory = vi.fn((_path: string, _mode: AgyMode, id: string | null) => {
        const native = new FakeProcess(id);
        options.configure?.(native);
        natives.push(native);
        return native;
    });
    const driver = new AgyPtyDriver(session, factory, () => transcript);
    const launched = driver.launch();
    const readyCount = () => client.sendSessionEvent.mock.calls.filter(([event]) => event.type === 'ready').length;
    const acknowledge = (text: string, plan = false) => transcript.append({ type: 14, userText: plan ? `/plan ${text}` : text });
    const finish = (text = 'Done') => { transcript.append({ type: 15, text }); natives.at(-1)!.state.busy = false; };
    cleanup.push(async () => { await driver.kill(); queue.close(); session.stopKeepAlive(); await launched; });
    return { driver, client, session, queue, transcript, natives, factory, handlers, readyCount, acknowledge, finish, state: () => state };
}
afterEach(async () => {
    try { for (const stop of cleanup.splice(0)) await stop(); }
    finally { vi.restoreAllMocks(); }
});

describe('Antigravity native driver', () => {
    it('answers usage queries without model input, durable prompt receipts, or terminal replacement', async () => {
        const h = harness({ configure: native => {
            native.nativeStatus = parseAgyNativeStatus(JSON.stringify({ agent_state: 'idle', quota: {
                'gemini-5h': { remaining_fraction: 0.5, reset_time: '2026-11-07T10:00:00Z' },
            } }));
        } });
        h.queue.pushIsolated('/usage', MODE, 'usage');
        await waitFor(() => expect(h.readyCount()).toBe(1));
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['usage']);
        expect(h.natives[0]!.submit).not.toHaveBeenCalled();
        expect(h.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: expect.stringContaining('50.00%') }));
        expect(h.factory).toHaveBeenCalledOnce();
        expect(h.natives[0]!.close).not.toHaveBeenCalled();
    });

    it('keeps a healthy terminal usable after an unsupported command', async () => {
        const h = harness();
        h.queue.pushIsolated('/logout', MODE, 'unsupported');
        await waitFor(() => expect(h.readyCount()).toBe(1));
        expect(h.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'error', message: expect.stringContaining('/help') });
        expect(h.natives[0]!.close).not.toHaveBeenCalled();
        expect(h.client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'abort-restore' }));
        h.queue.push('continue', MODE, 'continue');
        await waitFor(() => expect(h.natives[0]!.inputs).toHaveLength(1));
        h.acknowledge('continue'); h.finish();
        await waitFor(() => expect(h.readyCount()).toBe(2));
        expect(h.factory).toHaveBeenCalledOnce();
    });

    it('compacts after earlier work and then delivers the following prompt on the same native conversation', async () => {
        const h = harness();
        h.queue.push('first', MODE, 'first');
        await waitFor(() => expect(h.natives[0]!.inputs).toHaveLength(1));
        h.acknowledge('first');
        h.queue.pushIsolated('/compact', MODE, 'compact');
        h.queue.push('next', MODE, 'next');
        expect(h.natives[0]!.compact).not.toHaveBeenCalled();
        h.finish();
        await waitFor(() => expect(h.natives[0]!.inputs).toHaveLength(2));
        expect(h.natives[0]!.compact).toHaveBeenCalledOnce();
        expect(h.natives[0]!.inputs[1]!.text).toBe('next');
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(['compact']);
        expect(h.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: 'Conversation compacted.' }));
        h.acknowledge('next'); h.finish();
        await waitFor(() => expect(h.readyCount()).toBe(1));
        expect(h.factory).toHaveBeenCalledOnce();
    });

    it('clears the native context without deleting or replaying HAPI history', async () => {
        const h = harness();
        await waitFor(() => expect(h.client.emitSessionReady).toHaveBeenCalledOnce());
        h.queue.pushIsolated('/clear', MODE, 'clear');
        await waitFor(() => expect(h.readyCount()).toBe(1));
        expect(h.natives[0]!.close).toHaveBeenCalled();
        expect(h.transcript.close).toHaveBeenCalledOnce();
        expect(h.factory).toHaveBeenLastCalledWith('/tmp', MODE, null);
        expect(h.session.sessionId).toBeNull();
        const clearMetadata = h.client.updateMetadata.mock.calls.at(-1)![0];
        expect(clearMetadata({ agySessionId: ID, path: '/tmp', name: 'Keep history' })).toEqual({ path: '/tmp', name: 'Keep history' });
        expect(h.client.sendAgySessionMessage).not.toHaveBeenCalled();
        expect(h.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: expect.stringContaining('history is preserved') }));
    });

    it('publishes resumed and trailing idle context snapshots once with zero billable tokens', async () => {
        const snapshot = (tokens: number) => parseAgyNativeStatus(JSON.stringify({ agent_state: 'idle',
            context_window: { context_window_size: 100_000, used_percentage: tokens / 1000 } }));
        const h = harness({ configure: native => { native.nativeStatus = snapshot(50_000); } });
        const usage = () => h.client.sendAgentMessage.mock.calls.map(([message]) => message).filter(message => message?.type === 'token_count');
        await waitFor(() => expect(usage()).toHaveLength(1));
        expect(usage()[0]).toMatchObject({ info: { total: { inputTokens: 0, outputTokens: 0 }, contextTokens: 50_000, modelContextWindow: 100_000 } });
        h.queue.push('short reply', MODE, 'short');
        await waitFor(() => expect(h.natives[0]!.inputs).toHaveLength(1));
        h.acknowledge('short reply'); h.finish();
        await waitFor(() => expect(h.readyCount()).toBe(1));
        // The hook can arrive after the driver's final 150ms idle drain.
        h.natives[0]!.nativeStatus = snapshot(12_000);
        await waitFor(() => expect(usage()).toHaveLength(2));
        expect(usage()[1].info.contextTokens).toBe(12_000);
        await sleep(10);
        expect(usage()).toHaveLength(2);
        h.natives[0]!.nativeStatus = snapshot(0);
        await waitFor(() => expect(usage()).toHaveLength(3));
        expect(usage()[2].info.contextTokens).toBe(0);
    });

    it('prewarms a fresh terminal before its first message creates the native UUID', async () => {
        const h = harness({ fresh: true });
        await waitFor(() => expect(h.natives).toHaveLength(1));
        expect(h.natives[0]!.start).toHaveBeenCalledOnce();
        expect(h.client.emitSessionReady).not.toHaveBeenCalled();
        h.queue.push('first', MODE, 'first-id');
        await waitFor(() => expect(h.natives[0]!.inputs).toHaveLength(1));
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        h.acknowledge('first');
        h.finish();
        await waitFor(() => expect(h.readyCount()).toBe(1));
        expect(h.session.sessionId).toBe(ID);
        expect(h.client.emitSessionReady).toHaveBeenCalledOnce();
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['first-id']);
        expect(h.state().steeringActive).toBe(false);
    });

    it('reuses the process and applies Plan through mode selection, accepting only its exact prefixed receipt', async () => {
        const h = harness();
        h.queue.push('first', MODE, 'one');
        await waitFor(() => expect(h.natives[0]?.inputs).toHaveLength(1));
        h.acknowledge('first'); h.finish();
        await waitFor(() => expect(h.readyCount()).toBe(1));
        await h.session.applyConfig!({ permissionMode: 'plan' });
        h.queue.push('prepare a plan', { permissionMode: 'plan' }, 'two');
        await waitFor(() => expect(h.natives[0]!.inputs).toHaveLength(2));
        h.acknowledge('prepare a');
        await sleep(20);
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledTimes(1);
        h.acknowledge('prepare a plan', true); h.finish('Here is the plan');
        await waitFor(() => expect(h.readyCount()).toBe(2));
        expect(h.factory).toHaveBeenCalledOnce();
        expect(h.natives[0]!.setMode).toHaveBeenCalledWith('plan');
        expect(h.client.emitMessagesConsumed).toHaveBeenLastCalledWith(['two']);
    });

    it('keeps following a thinking turn past the receipt deadline after native paste normalization', async () => {
        const h = harness();
        const prompt = '\n  Check the receipt\n    and preserve indentation\n\n';
        h.queue.push(prompt, MODE, 'one');
        await waitFor(() => expect(h.natives[0]?.inputs).toHaveLength(1));
        h.acknowledge(prompt.trim());
        const index = h.transcript.append({ type: 15, status: 8, terminal: false, thinking: 'Checking the request' });
        await waitFor(() => expect(h.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'reasoning', message: 'Checking the request' })));
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['one']);

        const reads = h.transcript.read.mock.calls.length;
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
        await waitFor(() => expect(h.transcript.read.mock.calls.length).toBeGreaterThan(reads));
        expect(h.natives[0]!.close).not.toHaveBeenCalled();
        expect(h.client.emitSteerIndeterminate).not.toHaveBeenCalled();
        expect(h.client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
        clock.mockRestore();

        h.transcript.update(index, { status: 3, terminal: true });
        h.finish();
        await waitFor(() => expect(h.readyCount()).toBe(1));
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledOnce();
        expect(h.factory).toHaveBeenCalledOnce();
    });

    it('keeps a running command and later queue intact while native Steer receives guidance', async () => {
        const h = harness();
        h.queue.push('original', { permissionMode: 'auto' }, 'one');
        await waitFor(() => expect(h.natives[0]?.inputs).toHaveLength(1));
        h.acknowledge('original');
        const toolIndex = h.transcript.append({ type: 132, status: 2, terminal: false,
            tool: { id: 'real-call', name: 'run_command', input: { CommandLine: 'sleep 15' }, summary: '', output: '' } });
        await waitFor(() => expect(h.state().steeringActive).toBe(true));
        const guidance = '\n  say STEERED_DONE\n\n';
        h.queue.push(guidance, MODE, 'guide');
        h.queue.push('later', MODE, 'later');
        expect(await h.session.steerQueuedMessage!('guide')).toEqual({ steered: true });
        expect(h.natives[0]!.inputs[1]).toEqual({ text: guidance, steer: true });
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalledWith(['guide'], expect.anything());
        h.acknowledge('say STEERED_DONE');
        await waitFor(() => expect(h.client.emitMessagesConsumed).toHaveBeenCalledWith(['guide'], { steered: true }));
        expect(h.natives[0]!.close).not.toHaveBeenCalled();
        expect(h.natives[0]!.inputs).toHaveLength(2);
        h.transcript.update(toolIndex, { status: 3, terminal: true });
        await sleep(200);
        expect(h.natives[0]!.inputs).toHaveLength(2); // DONE tool, native still busy.
        h.finish('STEERED_DONE');
        await waitFor(() => expect(h.natives[0]!.inputs).toHaveLength(3));
        h.acknowledge('later'); h.finish();
        await waitFor(() => expect(h.readyCount()).toBe(1));
        expect(h.client.sendAgySessionMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'STEERED_DONE', id: expect.any(String) }), ID);
    });

    it('streams stable text and thinking IDs before completion and finalizes them on Stop', async () => {
        const h = harness();
        h.queue.push('work', MODE, 'one');
        await waitFor(() => expect(h.natives[0]?.inputs).toHaveLength(1));
        h.acknowledge('work');
        const index = h.transcript.append({ type: 15, status: 8, terminal: false, text: 'Hel', thinking: 'Consider' });
        await waitFor(() => expect(h.client.sendAgySessionMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'Hel' }), ID));
        expect(h.readyCount()).toBe(0);
        h.transcript.update(index, { text: 'Hello', thinking: 'Consider carefully' });
        await h.handlers.get(RPC_METHODS.Abort)!();
        expect(h.session.thinking).toBe(false);
        const prose = h.client.sendAgySessionMessage.mock.calls.map(([entry]) => entry);
        expect(new Set(prose.map(entry => entry.id)).size).toBe(1);
        expect(prose.at(-1)?.content).toBe('Hello');
        const reasoning = h.client.sendAgentMessage.mock.calls.map(([entry]) => entry).filter(entry => entry?.type === 'reasoning');
        expect(reasoning[0]).toMatchObject({ live: true });
        expect(reasoning.at(-1)?.live).toBeUndefined();
        expect(reasoning.at(-1)?.message).toBe('Consider carefully');
        expect(h.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'abort-restore', text: 'work' });
    });

    it('does not replay resumed history and keeps queued model snapshots across a config change', async () => {
        const transcript = new MemoryTranscript();
        transcript.append({ type: 14, userText: 'old' }); transcript.append({ text: 'old reply' });
        const h = harness({ transcript });
        h.queue.push('first', { ...MODE, model: 'model-A' }, 'one');
        await waitFor(() => expect(h.natives.at(-1)?.inputs).toHaveLength(1));
        expect(h.client.sendAgySessionMessage).not.toHaveBeenCalled();
        h.acknowledge('first');
        h.queue.push('second', { ...MODE, model: 'model-B' }, 'two');
        h.finish();
        await waitFor(() => expect(h.natives.at(-1)?.inputs[0]?.text).toBe('second'));
        expect(h.factory).toHaveBeenLastCalledWith('/tmp', expect.objectContaining({ model: 'model-B' }), ID);
        h.acknowledge('second'); h.finish();
        await waitFor(() => expect(h.readyCount()).toBe(1));
        expect(h.client.sendAgySessionMessage.mock.calls.some(([entry]) => entry.content === 'old reply')).toBe(false);
    });

    it('holds uncertain sends and never retries the native input automatically', async () => {
        const h = harness({ configure: native => native.submit.mockImplementation(async () => {
            throw new AgyIndeterminateDeliveryError('Connection lost after Enter');
        }) });
        h.queue.push('uncertain', MODE, 'one');
        await waitFor(() => expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['one']));
        expect(h.natives[0]!.submit).toHaveBeenCalledOnce();
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        expect(h.client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'abort-restore' }));
    });

    it('clears a pending approval on Stop and rejects a late click without native input', async () => {
        const h = harness();
        h.queue.push('run command', MODE, 'one');
        await waitFor(() => expect(h.natives[0]?.inputs).toHaveLength(1));
        h.acknowledge('run command');
        const menu = { target: 'echo ok', question: 'Run this command?', options: [{ index: 1, text: 'Yes, run command' }, { index: 2, text: 'No, cancel' }], selected: 1, identity: 'native-menu' };
        h.natives[0]!.state = { ...h.natives[0]!.state, kind: 'permission', permission: menu };
        h.transcript.append({ type: 132, status: 9, terminal: false,
            tool: { id: 'native-call', name: 'run_command', input: { CommandLine: 'echo ok' }, summary: '', output: '' },
            permission: { kind: 'permission', variant: 21, action: 'command', target: 'echo ok', description: '', reason: '' } });
        await waitFor(() => expect(Object.values(h.state().requests ?? {})).toContainEqual(expect.objectContaining({ tool: 'Bash', toolCallId: 'native-call' })));
        const replyId = Object.keys(h.state().requests!)[0]!;
        expect(h.state().steeringActive).toBe(false);
        await h.handlers.get(RPC_METHODS.Abort)!();
        expect(h.state().requests?.[replyId]).toBeUndefined();
        expect(h.state().completedRequests?.[replyId]).toMatchObject({ status: 'canceled' });
        expect(h.client.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-call-result', callId: 'native-call', is_error: true }));
        await h.handlers.get(RPC_METHODS.Permission)!({ id: replyId, approved: true });
        expect(h.natives[0]!.respond).not.toHaveBeenCalled();
    });

    it('does not restore completed input when the user stops an idle warmed process', async () => {
        const h = harness();
        h.queue.push('completed', MODE, 'one');
        await waitFor(() => expect(h.natives[0]?.inputs).toHaveLength(1));
        h.acknowledge('completed'); h.finish();
        await waitFor(() => expect(h.readyCount()).toBe(1));
        await h.handlers.get(RPC_METHODS.Abort)!();
        expect(h.client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'abort-restore' }));
    });
});
