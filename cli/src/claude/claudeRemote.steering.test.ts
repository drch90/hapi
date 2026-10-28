import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sdk from './sdk';
import type { SDKMessage, SDKUserMessage } from './sdk';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import type { ClaudeSteerTarget } from './steering';

vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
vi.mock('@/modules/watcher/awaitFileExist', () => ({ awaitFileExist: async () => true }));
vi.mock('./sdk/utils', () => ({ getDefaultClaudeCodePath: () => '/usr/bin/claude' }));

import { claudeRemote } from './claudeRemote';

afterEach(() => vi.restoreAllMocks());

async function harness() {
    const output = new PushableAsyncIterable<SDKMessage>();
    const prompts: SDKMessage[] = [];
    const writes: SDKUserMessage[] = [];
    let promptReader: Promise<void> | undefined;
    const query = vi.spyOn(sdk, 'query').mockImplementation(({ prompt }) => {
        promptReader = (async () => {
            for await (const message of prompt as AsyncIterable<SDKMessage>) prompts.push(message);
        })();
        return {
            [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
            sendUserMessage: (message: SDKUserMessage) => { writes.push(message); return true; }
        } as ReturnType<typeof sdk.query>;
    });
    const controller = new AbortController();
    const onReady = vi.fn();
    const onResult = vi.fn();
    const onSteerEcho = vi.fn();
    const targets: Array<ClaudeSteerTarget | null> = [];
    const onThinkingChange = vi.fn();
    let finishQueue!: () => void;
    const nextQueued = new Promise<null>(resolve => { finishQueue = () => resolve(null); });
    const nextMessage = vi.fn()
        .mockResolvedValueOnce({ message: 'start foreground tool', mode: { permissionMode: 'default' } })
        .mockImplementation(() => nextQueued);
    const run = claudeRemote({
        sessionId: null, path: '/tmp/steering', allowedTools: [], hookSettingsPath: '/tmp/hooks.json',
        signal: controller.signal, canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        nextMessage, onReady, onResult, onSteerEcho, onThinkingChange,
        onSteeringTarget: target => { targets.push(target); },
        isAborted: () => false, onSessionFound: () => {}, onMessage: () => {}
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(targets.some(Boolean)).toBe(false);
    output.push({ type: 'system', subtype: 'init' });
    output.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'foreground', name: 'Bash', input: { command: 'sleep 12' } }] } });
    await vi.waitFor(() => expect(targets.at(-1)).toBeTruthy());
    const target = targets.at(-1)!;
    const steer: SDKUserMessage = { type: 'user', uuid: 'bc5a895d-d7cc-4943-8bb0-40156990895b', message: { role: 'user', content: 'change the next action' } };
    const finish = async () => {
        controller.abort();
        finishQueue();
        output.end();
        await run;
        await promptReader;
    };
    return { output, prompts, writes, query, target, targets, steer, nextMessage, onReady, onResult, onSteerEcho, onThinkingChange, controller, finish };
}

describe('Claude active-turn stdin injection', () => {
    it('injects before result, waits for the UUID echo and leaves normal messages behind the turn', async () => {
        const h = await harness();
        try {
            expect(h.query.mock.calls[0][0].options?.replayUserMessages).toBe(true);
            expect(h.target.send(h.steer)).toBe(true);
            expect(h.writes).toEqual([h.steer]);
            expect(h.nextMessage).toHaveBeenCalledOnce();
            expect(h.onReady).not.toHaveBeenCalled();
            expect(h.onSteerEcho).not.toHaveBeenCalled();
            h.output.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'foreground', content: 'completed normally' }] } });
            h.output.push({ ...h.steer, isReplay: true });
            await vi.waitFor(() => expect(h.onSteerEcho).toHaveBeenCalledExactlyOnceWith(h.steer.uuid));
            expect(h.nextMessage).toHaveBeenCalledOnce();
            h.output.push({ type: 'result', subtype: 'success' });
            await vi.waitFor(() => expect(h.onReady).toHaveBeenCalledOnce());
            expect(h.nextMessage).toHaveBeenCalledTimes(2);
            expect(h.targets.at(-1)).toBeNull();
            expect(h.target.send(h.steer)).toBe(false);
            expect(h.writes).toHaveLength(1);
        } finally { await h.finish(); }
    });

    it('does not announce ready or drain the queue when a write races the result', async () => {
        const h = await harness();
        try {
            h.target.send(h.steer);
            h.output.push({ type: 'result', subtype: 'success' });
            await vi.waitFor(() => expect(h.onResult).toHaveBeenCalledOnce());
            expect(h.targets.at(-1)).toBe(h.target);
            const second = { ...h.steer, uuid: 'second-guidance', message: { role: 'user' as const, content: 'another correction' } };
            expect(h.target.send(second)).toBe(true);
            expect(h.writes).toHaveLength(2);
            expect(h.onReady).not.toHaveBeenCalled();
            expect(h.nextMessage).toHaveBeenCalledOnce();
            expect(h.onThinkingChange).not.toHaveBeenCalledWith(false);
            h.output.push({ ...h.steer, isReplay: true });
            await vi.waitFor(() => expect(h.onSteerEcho).toHaveBeenCalledOnce());
            expect(h.onReady).not.toHaveBeenCalled();
            h.output.push({ ...second, isReplay: true });
            await vi.waitFor(() => expect(h.onSteerEcho).toHaveBeenCalledTimes(2));
            h.output.push({ type: 'result', subtype: 'success' });
            await vi.waitFor(() => expect(h.onReady).toHaveBeenCalledOnce());
            expect(h.targets.at(-1)).toBeNull();
            expect(h.nextMessage).toHaveBeenCalledTimes(2);
        } finally { await h.finish(); }
    });

    it('does not accept unrelated/synthetic/sidechain user output as consumption', async () => {
        const h = await harness();
        try {
            h.target.send(h.steer);
            h.output.push({ ...h.steer, isSynthetic: true });
            h.output.push({ ...h.steer, isReplay: true, isSynthetic: true });
            h.output.push({ ...h.steer, isReplay: true, isMeta: true });
            h.output.push({ ...h.steer, isReplay: true, parent_tool_use_id: 'child' });
            h.output.push({ type: 'result', subtype: 'success' });
            await vi.waitFor(() => expect(h.onResult).toHaveBeenCalledOnce());
            expect(h.onSteerEcho).not.toHaveBeenCalled();
            expect(h.onReady).not.toHaveBeenCalled();
        } finally { await h.finish(); }
    });

    it('invalidates the turn synchronously when the user aborts', async () => {
        const h = await harness();
        try {
            h.controller.abort();
            expect(h.target.send(h.steer)).toBe(false);
            expect(h.targets.at(-1)).toBeNull();
            expect(h.writes).toHaveLength(0);
        } finally { await h.finish(); }
    });
});
