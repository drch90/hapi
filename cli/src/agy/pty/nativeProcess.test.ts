import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPtyManager } from '@/agent/AgentPtyManager';
import { NativeAgyProcess } from './nativeProcess';
import { AgyIndeterminateDeliveryError } from './delivery';
import type { AgyNativeMode } from './terminalState';
import { parseAgyNativeStatus } from './nativeStatus';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function harness() {
    const native = new NativeAgyProcess('/tmp', { permissionMode: 'request-review' }, '42c2e6b6-efca-4b44-85bb-746e6ef993ad');
    native.state = { kind: 'prompt', busy: false, mode: 'default', editor: '', footer: '? for shortcuts', lines: [] };
    vi.spyOn(AgentPtyManager.prototype, 'isRunning', 'get').mockReturnValue(true);
    const write = vi.spyOn(AgentPtyManager.prototype, 'write').mockImplementation(() => {});
    const permissionPending = vi.spyOn(native, 'permissionPending', 'get').mockReturnValue(true);
    return { native, write, permissionPending };
}

describe('native Antigravity input serialization', () => {
    it('cycles from the confirmed current mode instead of assuming a fixed number of keys', async () => {
        const h = harness();
        const modes: AgyNativeMode[] = ['default', 'accept-edits', 'auto', 'plan'];
        h.write.mockImplementation(key => {
            expect(key).toBe('\x1b[Z');
            h.native.state.mode = modes[(modes.indexOf(h.native.state.mode!) + 1) % modes.length]!;
        });
        await h.native.setMode('plan');
        expect(h.write).toHaveBeenCalledTimes(3);
        await h.native.setMode('request-review');
        expect(h.write).toHaveBeenCalledTimes(4);
        await h.native.setMode('request-review');
        expect(h.write).toHaveBeenCalledTimes(4);
    });

    it('fails an unavailable native Auto selection and a live bypass change', async () => {
        const h = harness();
        const modes: AgyNativeMode[] = ['default', 'accept-edits', 'plan'];
        h.write.mockImplementation(() => { h.native.state.mode = modes[(modes.indexOf(h.native.state.mode!) + 1) % modes.length]!; });
        await expect(h.native.setMode('auto')).rejects.toThrow('unavailable');
        await expect(h.native.setMode('always-proceed')).rejects.toThrow('restarting');
    });

    it('pastes once and presses Enter separately only after the editor accepts it', async () => {
        const h = harness(); let revision = 0;
        vi.spyOn(h.native, 'revision', 'get').mockImplementation(() => revision);
        h.write.mockImplementation(key => {
            if (key.startsWith('\x1b[200~')) { revision++; h.native.state.editor = 'hello\nworld'; }
        });
        const before = vi.fn(async () => { expect(h.write).not.toHaveBeenCalled(); });
        await h.native.submit('hello\nworld', false, before);
        expect(before).toHaveBeenCalledOnce();
        expect(h.write.mock.calls.map(([key]) => key)).toEqual(['\x1b[200~hello\nworld\x1b[201~', '\r']);
    });

    it('cannot send text while a native dialog owns input', async () => {
        const h = harness(); h.native.state.kind = 'permission';
        await expect(h.native.submit('hello', true, async () => {})).rejects.toThrow('dialog');
        expect(h.write).not.toHaveBeenCalled();
    });

    it('submits compact through native completion and waits for the actual compaction result', async () => {
        const h = harness();
        // A final hook can still contain the previous zero-context snapshot.
        (h.native as unknown as { status: unknown }).status = parseAgyNativeStatus('{"agent_state":"idle","context_window":{"context_window_size":100000,"used_percentage":0}}');
        let revision = 0;
        vi.spyOn(h.native, 'revision', 'get').mockImplementation(() => revision);
        h.write.mockImplementation(key => {
            revision++;
            if (key.startsWith('\x1b[200~')) h.native.state = { ...h.native.state, kind: 'command', editor: '/compact' };
            else if (key === '\r') h.native.state = { ...h.native.state, kind: 'prompt', editor: '', busy: true, lines: ['> /compact', 'Compacting conversation…'] };
        });
        const wait = vi.spyOn(h.native, 'waitForChange').mockImplementation(async () => {
            h.native.state = { ...h.native.state, busy: false, lines: ['> /compact', '── Conversation compacted ──', '12 steps summarized · context 50k → 10k', '>', '? for shortcuts'] };
        });
        await expect(h.native.compact()).resolves.toContain('12 steps summarized');
        expect(wait).toHaveBeenCalledOnce();
        expect(h.write.mock.calls.map(([key]) => key)).toEqual(['\x1b[200~/compact\x1b[201~', '\r']);
    });

    it('accepts repeated native empty-compaction results without treating history as a current result', async () => {
        const h = harness(); let revision = 0;
        const separator = '─'.repeat(40);
        const empty = [separator, '> Nothing to compact yet.', separator, '? for shortcuts'];
        h.native.state.lines = empty;
        vi.spyOn(h.native, 'revision', 'get').mockImplementation(() => revision);
        h.write.mockImplementation(key => {
            revision++;
            h.native.state = key === '\r'
                ? { ...h.native.state, kind: 'prompt', editor: '', lines: empty }
                : { ...h.native.state, kind: 'command', editor: '/compact', lines: [separator, '> /compact', separator] };
        });
        await expect(h.native.compact()).resolves.toBe('Nothing to compact yet.');
        await expect(h.native.compact()).resolves.toBe('Nothing to compact yet.');
        expect(h.write).toHaveBeenCalledTimes(4);
    });

    it('has nothing to compact before the first native conversation exists', async () => {
        const h = harness(); h.native.sessionId = null;
        await expect(h.native.compact()).resolves.toBe('Nothing to compact yet.');
        expect(h.write).not.toHaveBeenCalled();
    });

    it('reports an unavailable native command immediately and clears the failed terminal through normal cleanup', async () => {
        const h = harness(); let revision = 0;
        vi.spyOn(h.native, 'revision', 'get').mockImplementation(() => revision);
        h.write.mockImplementation(key => {
            revision++;
            h.native.state = key === '\r'
                ? { ...h.native.state, kind: 'other', editor: null, lines: ['─'.repeat(40), '> Unknown command: /compact', '─'.repeat(40)] }
                : { ...h.native.state, kind: 'command', editor: '/compact' };
        });
        await expect(h.native.compact()).rejects.toThrow('does not expose /compact');
        expect(h.native.failure).toBeInstanceOf(Error);
    });

    it('does not compact an active turn or press Enter when the pasted command differs', async () => {
        const h = harness();
        h.native.state.busy = true;
        await expect(h.native.compact()).rejects.toThrow('idle');
        expect(h.write).not.toHaveBeenCalled();
        h.native.state.busy = false;
        let revision = 0;
        vi.spyOn(h.native, 'revision', 'get').mockImplementation(() => revision);
        h.write.mockImplementation(() => { revision++; h.native.state = { ...h.native.state, kind: 'command', editor: '/clear' }; });
        await expect(h.native.compact()).rejects.toThrow('input changed');
        expect(h.write).toHaveBeenCalledOnce();
    });

    it('does not mistake an old compaction result for the new operation finishing', async () => {
        const h = harness(); let revision = 0;
        h.native.state.lines = ['> /compact', '── Conversation compacted ──', 'old summary'];
        vi.spyOn(h.native, 'revision', 'get').mockImplementation(() => revision);
        h.write.mockImplementation(key => {
            revision++;
            h.native.state.editor = key === '\r' ? '' : '/compact';
        });
        const wait = vi.spyOn(h.native, 'waitForChange').mockImplementation(async () => {
            h.native.failure = new Error('Native stopped during compaction');
        });
        await expect(h.native.compact()).rejects.toThrow('stopped during compaction');
        expect(wait).toHaveBeenCalledOnce();
    });

    it('marks a failure at Enter uncertain instead of retrying the paste', async () => {
        const h = harness(); let revision = 0;
        vi.spyOn(h.native, 'revision', 'get').mockImplementation(() => revision);
        h.write.mockImplementation(key => {
            if (key === '\r') throw new Error('Lost terminal');
            revision++; h.native.state.editor = 'hello';
        });
        await expect(h.native.submit('hello', false, async () => {})).rejects.toBeInstanceOf(AgyIndeterminateDeliveryError);
        expect(h.write).toHaveBeenCalledTimes(2);
    });

    it('navigates to Deny and rechecks the native request immediately before Enter', async () => {
        const h = harness();
        const menu = { target: 'echo ok', question: 'Run this command?', selected: 1, identity: 'permission',
            options: [{ index: 1, text: 'Yes, run command' }, { index: 2, text: 'Yes, and always allow' }, { index: 3, text: 'No, cancel' }] };
        h.native.state = { ...h.native.state, kind: 'permission', permission: menu };
        h.write.mockImplementation(key => { if (key === '\x1b[B') menu.selected++; });
        const validate = vi.fn(async () => true);
        await h.native.respond(menu, false, validate);
        expect(h.write.mock.calls.map(([key]) => key)).toEqual(['\x1b[B', '\x1b[B', '\r']);
        expect(validate).toHaveBeenCalledTimes(2);
    });

    it('does not press Enter if the request changes during menu navigation', async () => {
        const h = harness();
        const menu = { target: 'echo ok', question: 'Run this command?', selected: 2, identity: 'permission',
            options: [{ index: 1, text: 'Yes, run command' }, { index: 2, text: 'No, cancel' }] };
        h.native.state = { ...h.native.state, kind: 'permission', permission: menu };
        h.write.mockImplementation(key => { if (key === '\x1b[A') menu.selected--; });
        const validate = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        await expect(h.native.respond(menu, true, validate)).rejects.toThrow('no longer active');
        expect(h.write).toHaveBeenCalledExactlyOnceWith('\x1b[A');
    });

    it('waits for the structured native approval status before sending any keys', async () => {
        const h = harness();
        const menu = { target: 'echo ok', question: 'Run this command?', selected: 1, identity: 'permission',
            options: [{ index: 1, text: 'Yes, run command' }, { index: 2, text: 'No, cancel' }] };
        h.native.state = { ...h.native.state, kind: 'permission', permission: menu };
        h.permissionPending.mockReturnValue(false);
        const refresh = vi.spyOn(h.native, 'refreshStatus').mockResolvedValue();
        const wait = vi.spyOn(h.native, 'waitForChange').mockImplementation(async () => {
            expect(h.write).not.toHaveBeenCalled();
            h.permissionPending.mockReturnValue(true);
        });

        await h.native.respond(menu, true, async () => true);

        expect(wait).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledTimes(3);
        expect(h.write).toHaveBeenCalledExactlyOnceWith('\r');
    });

    it('never answers a matching screen and DB request without native approval focus', async () => {
        vi.useFakeTimers();
        const h = harness();
        const menu = { target: 'echo ok', question: 'Run this command?', selected: 1, identity: 'permission',
            options: [{ index: 1, text: 'Yes, run command' }, { index: 2, text: 'No, cancel' }] };
        h.native.state = { ...h.native.state, kind: 'permission', permission: menu };
        h.permissionPending.mockReturnValue(false);

        const response = expect(h.native.respond(menu, true, async () => true)).rejects.toThrow('active native approval');
        await vi.advanceTimersByTimeAsync(2_000);
        await response;

        expect(h.write).not.toHaveBeenCalled();
    });

    it('does not press Enter when native approval focus clears during navigation', async () => {
        const h = harness();
        const menu = { target: 'echo ok', question: 'Run this command?', selected: 2, identity: 'permission',
            options: [{ index: 1, text: 'Yes, run command' }, { index: 2, text: 'No, cancel' }] };
        h.native.state = { ...h.native.state, kind: 'permission', permission: menu };
        h.write.mockImplementation(key => {
            if (key === '\x1b[A') {
                menu.selected--;
                h.permissionPending.mockReturnValue(false);
            }
        });

        await expect(h.native.respond(menu, true, async () => true)).rejects.toThrow('active native approval');

        expect(h.write).toHaveBeenCalledExactlyOnceWith('\x1b[A');
    });
});
