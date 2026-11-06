import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { AgentState } from '@/api/types';
import { AgyPtyPermissionHandler } from './permissionHandler';
import type { AgyProcess } from './nativeProcess';
import type { AgyNativeStep } from './transcript';

function request(id = 'call-1', command = 'echo ok'): AgyNativeStep {
    return { index: 2, type: 132, status: 9, terminal: false, failed: false, invalidated: false, createdAt: 0, executionId: 'run',
        userText: '', interrupting: false, text: '', thinking: '', messageId: '', model: '', error: '',
        tool: { id, name: 'run_command', input: { CommandLine: command }, summary: '', output: '' },
        permission: { kind: 'permission', variant: 21, action: 'command', target: command, description: '', reason: '' } };
}

function harness() {
    let state: AgentState = {};
    let rpc!: (value: { id: string; approved: boolean; decision?: string }) => Promise<void>;
    let current = request();
    let active = true;
    const client = { updateAgentState: (fn: (state: AgentState) => AgentState) => { state = fn(state); },
        rpcHandlerManager: { registerHandler: vi.fn((method, handler) => { if (method === RPC_METHODS.Permission) rpc = handler; }) } };
    const native = {
        state: { kind: 'permission', permission: { target: 'echo ok', question: 'Run this command?', selected: 1, identity: 'menu',
            options: [{ index: 1, text: 'Yes, run command' }, { index: 2, text: 'Yes, and always allow in this conversation' },
                { index: 3, text: 'Yes, always allow (Persist to settings.json)' }, { index: 4, text: 'No, cancel' }] } },
        failure: null,
        waitForChange: async () => {},
        respond: vi.fn(async (_menu, approved, validate) => {
            if (!await validate()) throw new Error('Request changed');
            current = { ...current, status: 2, permission: undefined, decision: { approved, target: '' } };
        }),
    };
    const abort = vi.fn(async () => { active = false; });
    const errors = vi.fn();
    const source = { read: async () => [current], maxIndex: async () => 2, close() {} };
    const handler = new AgyPtyPermissionHandler(client as never, native as unknown as AgyProcess, source, () => active, abort, errors);
    return { handler, native, errors, abort, state: () => state, current: () => current,
        setStep: (value: AgyNativeStep) => { current = value; }, sync: () => handler.sync([current]),
        pending: (toolId: string) => Object.values(state.requests ?? {}).find(value => value.toolCallId === toolId),
        completed: (toolId: string) => Object.values(state.completedRequests ?? {}).find(value => value.toolCallId === toolId),
        reply: (id: string) => rpc({ id, approved: true }),
        answer: (approved: boolean, decision?: string) => {
            const id = [...Object.entries(state.requests ?? {}), ...Object.entries(state.completedRequests ?? {})]
                .find(([, value]) => value.toolCallId === current.tool!.id)?.[0] ?? current.tool!.id;
            return rpc({ id, approved, decision });
        } };
}

describe('native Antigravity approval bridge', () => {
    it('shows a real native pending tool and waits for the HAPI answer', async () => {
        const h = harness(); h.sync();
        expect(h.pending('call-1')).toMatchObject({ tool: 'Bash', arguments: { command: 'echo ok' }, toolCallId: 'call-1' });
        expect(Object.keys(h.state().requests!)[0]).not.toBe('call-1');
        expect(h.native.respond).not.toHaveBeenCalled();
        await h.answer(true);
        expect(h.native.respond).toHaveBeenCalledOnce();
        expect(h.native.respond.mock.calls[0]![1]).toBe(true);
        expect(h.pending('call-1')).toBeUndefined();
        expect(h.completed('call-1')).toMatchObject({ status: 'approved', decision: 'approved' });
    });

    it('sends one native rejection and does not upgrade a denial to approval', async () => {
        const h = harness(); h.sync(); await h.answer(false);
        expect(h.native.respond.mock.calls[0]![1]).toBe(false);
        expect(h.completed('call-1')).toMatchObject({ status: 'denied' });
    });

    it('keeps session grants in memory for the exact native input only', async () => {
        const h = harness(); h.sync(); await h.answer(true, 'approved_for_session');
        h.setStep(request('call-2')); h.sync();
        await vi.waitFor(() => expect(h.completed('call-2')?.status).toBe('approved'));
        expect(h.native.respond).toHaveBeenCalledTimes(2);
        h.setStep(request('call-3', 'echo different'));
        h.native.state.permission.target = 'echo different';
        h.sync();
        expect(h.pending('call-3')).toBeDefined();
        expect(h.native.respond).toHaveBeenCalledTimes(2);
        h.handler.close();
    });

    it('ignores duplicate answers and answers to a withdrawn request', async () => {
        const h = harness(); h.sync(); await h.answer(true); await h.answer(true);
        expect(h.native.respond).toHaveBeenCalledOnce();
        h.setStep(request('call-2')); h.sync();
        h.setStep({ ...h.current(), status: 3, terminal: true, permission: undefined }); h.sync();
        await h.answer(true);
        expect(h.native.respond).toHaveBeenCalledOnce();
        expect(h.completed('call-2')?.status).toBe('canceled');
    });

    it('never creates an approval from terminal prose alone, unknown variants or ambiguous targets', () => {
        const h = harness();
        h.handler.sync([]);
        expect(h.state().requests).toBeUndefined();
        h.handler.sync([{ ...request(), permission: { ...request().permission!, kind: 'unsupported', variant: 23 } }]);
        expect(h.state().requests).toBeUndefined();
        h.handler.sync([request('one'), request('two')]);
        expect(h.state().requests).toBeUndefined();
        h.setStep(request('other', 'different command')); h.sync();
        expect(h.state().requests).toBeUndefined();
    });

    it('does not offer menus that have only persistent allow choices', () => {
        const h = harness(); h.native.state.permission.options.shift(); h.sync();
        expect(h.state().requests).toBeUndefined();
    });

    it('revalidates the exact request after an answer and leaves a newer operation alone', async () => {
        const h = harness(); h.sync();
        h.native.respond.mockImplementation(async (_menu, _approved, validate) => {
            h.setStep(request('new-call', 'new command'));
            expect(await validate()).toBe(false);
            throw new Error('Request changed');
        });
        await h.answer(true);
        expect(h.completed('call-1')?.status).toBe('canceled');
        expect(h.errors).not.toHaveBeenCalled();
    });

    it('clears pending state on close and can abort without pressing an allow key', async () => {
        const h = harness(); h.sync(); await h.answer(false, 'abort');
        expect(h.abort).toHaveBeenCalledOnce();
        expect(h.native.respond).not.toHaveBeenCalled();
        expect(h.completed('call-1')?.status).toBe('canceled');
        h.handler.close();
        await h.answer(true);
        expect(h.native.respond).not.toHaveBeenCalled();
    });

    it('does not reuse a reply ID when the same native tool requests approval again', async () => {
        const h = harness(); h.sync();
        const oldId = Object.keys(h.state().requests!)[0]!;
        h.setStep({ ...request(), permission: undefined, status: 3, terminal: true }); h.sync();
        h.setStep(request()); h.sync();
        const newId = Object.keys(h.state().requests!)[0]!;
        expect(newId).not.toBe(oldId);
        await h.reply(oldId);
        expect(h.native.respond).not.toHaveBeenCalled();
        expect(h.pending('call-1')).toBeDefined();
        await h.answer(true);
        expect(h.native.respond).toHaveBeenCalledOnce();
    });
});
