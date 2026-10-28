import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';
import type { Session } from './session';
import { ClaudeSteering } from './steering';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function harness() {
    const mode: EnhancedMode = { permissionMode: 'default' };
    const queue = new MessageQueue2<EnhancedMode>(value => JSON.stringify(value));
    const client = {
        sessionId: 'hub-session',
        updateAgentState: vi.fn(),
        setSteerDeliveryState: vi.fn(async () => true),
        emitSteerIndeterminate: vi.fn(),
        emitMessagesConsumed: vi.fn()
    };
    const settings = { ...mode };
    const session = {
        queue, client,
        getPermissionMode: () => settings.permissionMode,
        getModel: () => settings.model,
        getEffort: () => settings.effort,
        expandSkillReference: (text: string) => text.replace(/^\$review\b/, '/review')
    } as unknown as Session;
    const flush = vi.fn(async () => {});
    const steering = new ClaudeSteering(session, flush);
    const send = vi.fn(() => true);
    const target = { mode, send };
    steering.setTarget(target);
    queue.push('use the new direction', mode, 'guidance');
    const uuid = () => (send.mock.calls[0] as unknown as [{ uuid: string }])[0].uuid;
    return { queue, client, settings, steering, send, target, flush, uuid };
}

describe('Claude steer reservations', () => {
    it('returns after dispatch but consumes once only after the matching UUID echo and output flush', async () => {
        const h = harness();
        expect(await h.steering.steer('guidance')).toEqual({ steered: true });
        expect(h.client.setSteerDeliveryState).toHaveBeenCalledWith(['guidance'], 'dispatching');
        expect(h.send).toHaveBeenCalledExactlyOnceWith({
            type: 'user', uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
            message: { role: 'user', content: 'use the new direction' }
        });
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        expect(h.queue.cancelByLocalId('guidance')).toBe('in-flight');
        expect(await h.steering.steer('guidance')).toEqual({ steered: true });
        expect(h.send).toHaveBeenCalledOnce();
        await h.steering.acknowledge('unrelated-uuid');
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();

        const flushed = deferred<void>();
        h.flush.mockReturnValueOnce(flushed.promise);
        const acknowledged = h.steering.acknowledge(h.uuid());
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        flushed.resolve();
        await acknowledged;
        await h.steering.acknowledge(h.uuid());
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['guidance'], { steered: true });
        expect(h.queue.cancelByLocalId('guidance')).toBe('consumed');
        expect(await h.steering.steer('guidance')).toMatchObject({ steered: false });
        expect(h.send).toHaveBeenCalledOnce();
    });

    it('does not resend or restore when a long tool delays its echo beyond the RPC timeout', async () => {
        vi.useFakeTimers();
        try {
            const h = harness();
            await h.steering.steer('guidance');
            await vi.advanceTimersByTimeAsync(120_000);
            expect(h.send).toHaveBeenCalledOnce();
            expect(h.queue.size()).toBe(0);
            expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
            expect(h.client.emitSteerIndeterminate).not.toHaveBeenCalled();
            await h.steering.acknowledge(h.uuid());
            expect(h.client.emitMessagesConsumed).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reserves synchronously so concurrent clicks cannot dispatch the same item twice', async () => {
        const h = harness();
        const persisted = deferred<boolean>();
        h.client.setSteerDeliveryState.mockReturnValueOnce(persisted.promise);
        const request = h.steering.steer('guidance');
        expect(await h.steering.steer('guidance')).toMatchObject({ steered: false });
        persisted.resolve(true);
        expect(await request).toEqual({ steered: true });
        expect(h.send).toHaveBeenCalledOnce();
        await h.steering.closeProcess();
    });

    it('restores FIFO if the active turn changes before the write', async () => {
        const h = harness();
        h.queue.push('ordinary follow-up', h.target.mode, 'ordinary');
        h.client.setSteerDeliveryState.mockImplementationOnce(async () => {
            h.steering.setTarget({ ...h.target });
            return true;
        });
        expect(await h.steering.steer('guidance')).toMatchObject({ steered: false });
        expect(h.send).not.toHaveBeenCalled();
        expect(h.queue.queue.map(item => item.localId)).toEqual(['guidance', 'ordinary']);
        expect(h.client.setSteerDeliveryState).toHaveBeenLastCalledWith(['guidance'], 'queued');
    });

    it('restores a definite pre-write refusal without consuming it', async () => {
        const h = harness();
        h.send.mockReturnValueOnce(false);
        expect(await h.steering.steer('guidance')).toMatchObject({ steered: false });
        expect(h.queue.size()).toBe(1);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
    });

    it.each(['persist', 'write', 'restore'] as const)('holds ambiguous %s failure outside normal draining', async failure => {
        const h = harness();
        if (failure === 'persist') h.client.setSteerDeliveryState.mockResolvedValueOnce(false);
        if (failure === 'write') h.send.mockImplementationOnce(() => { throw new Error('broken pipe'); });
        if (failure === 'restore') {
            h.send.mockReturnValueOnce(false);
            h.client.setSteerDeliveryState.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        }
        expect(await h.steering.steer('guidance')).toMatchObject({ steered: false });
        await h.steering.closeProcess();
        h.steering.setTarget({ ...h.target });
        expect(await h.steering.steer('guidance')).toMatchObject({ steered: false });
        expect(h.queue.size()).toBe(0);
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledExactlyOnceWith(['guidance']);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        expect(h.send).toHaveBeenCalledTimes(failure === 'persist' ? 0 : 1);
    });

    it('holds input on process exit and does not replay it into the replacement process', async () => {
        const h = harness();
        await h.steering.steer('guidance');
        h.queue.reset({ preserveDispatchingReservations: true });
        await h.steering.closeProcess();
        h.steering.setTarget({ ...h.target });
        await h.steering.steer('guidance');
        expect(h.send).toHaveBeenCalledOnce();
        expect(h.queue.size()).toBe(0);
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['guidance']);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        expect(h.queue.cancelByLocalId('guidance')).toBe(true);
    });

    it('can accept a late echo after disabling steer at the result boundary', async () => {
        const h = harness();
        await h.steering.steer('guidance');
        h.steering.setTarget(null);
        await h.steering.acknowledge(h.uuid());
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledOnce();
        await h.steering.closeProcess();
        expect(h.client.emitSteerIndeterminate).not.toHaveBeenCalled();
    });

    it('does not strand a durable dispatch when /clear drops its local reservation before writing', async () => {
        const h = harness();
        h.client.setSteerDeliveryState.mockImplementationOnce(async () => {
            h.queue.pushIsolateAndClear('/clear', h.target.mode, 'clear');
            return true;
        });
        expect(await h.steering.steer('guidance')).toMatchObject({ steered: false });
        expect(h.send).not.toHaveBeenCalled();
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['guidance']);
        expect(h.queue.queue.map(item => item.localId)).toEqual(['clear']);
    });

    it('settles a written input echoed after /clear was queued without replaying it', async () => {
        const h = harness();
        await h.steering.steer('guidance');
        h.queue.pushIsolateAndClear('/clear', h.target.mode, 'clear');
        await h.steering.acknowledge(h.uuid());
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledOnce();
        expect(h.queue.queue.map(item => item.localId)).toEqual(['clear']);
        expect(h.send).toHaveBeenCalledOnce();
    });

    it('keeps a message held when /clear races the queued-state restore acknowledgement', async () => {
        const h = harness();
        h.send.mockReturnValueOnce(false);
        h.client.setSteerDeliveryState.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
            h.queue.pushIsolateAndClear('/clear', h.target.mode, 'clear');
            return true;
        });
        expect(await h.steering.steer('guidance')).toMatchObject({ steered: false });
        expect(h.queue.queue.map(item => item.localId)).toEqual(['clear']);
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['guidance']);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
    });

    it.each(['/model foo', '/clear', '/compact', '/plan', '$review code', '  '])('keeps control/empty input %j queued', async text => {
        const h = harness();
        h.queue.push(text, h.target.mode, 'command');
        expect(await h.steering.steer('command')).toMatchObject({ steered: false });
        expect(h.send).not.toHaveBeenCalled();
        expect(h.queue.peekByLocalId('command')?.message).toBe(text);
    });

    it('uses the active turn for guidance queued before a model or permission change', async () => {
        const h = harness();
        h.queue.push('different context', { permissionMode: 'plan', model: 'old-model', effort: 'high' }, 'different');
        h.settings.model = 'next-turn-model';
        h.settings.permissionMode = 'acceptEdits';
        h.client.setSteerDeliveryState.mockImplementationOnce(async () => {
            h.settings.effort = 'low';
            return true;
        });
        expect(await h.steering.steer('different')).toEqual({ steered: true });
        expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ message: { role: 'user', content: 'different context' } }));
        expect(h.settings.model).toBe('next-turn-model');
        expect(h.settings.permissionMode).toBe('acceptEdits');
        expect(h.settings.effort).toBe('low');
        await h.steering.acknowledge(h.uuid());
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['different'], { steered: true });
    });
});
