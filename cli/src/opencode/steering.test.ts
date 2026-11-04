import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { OpencodeSession } from './session';
import type { OpencodeMode } from './types';
import { OpencodeSteering, type OpencodeSteeringTurn } from './steering';
import type { OpencodeSteerResult } from './utils/opencodeSteeringBridge';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}

function harness() {
    const mode: OpencodeMode = { permissionMode: 'default', model: 'provider/model' };
    const queue = new MessageQueue2<OpencodeMode>(JSON.stringify);
    queue.push('before', mode, 'before');
    queue.push('guidance', mode, 'guide');
    queue.push('after', mode, 'after');
    const client = {
        setSteerDeliveryState: vi.fn(async () => true),
        emitSteerIndeterminate: vi.fn(),
        emitMessagesConsumed: vi.fn(),
    };
    let turn: OpencodeSteeringTurn | null = {
        baseUrl: 'http://127.0.0.1:4321', password: 'test', sessionId: 'ses_test', generation: 1, modeHash: queue.modeHasher(mode),
    };
    const admission = deferred<OpencodeSteerResult>();
    const send = vi.fn(async () => admission.promise);
    const steering = new OpencodeSteering({ queue, client: client as unknown as OpencodeSession['client'] }, () => turn, { send });
    return { mode, queue, client, send, steering, admission, endTurn: () => { turn = null; }, nextTurn: () => { turn = { ...turn!, generation: 2 }; } };
}

describe('OpenCode queued steer delivery', () => {
    it('waits for native admission, rejects duplicate requests and consumes exactly once', async () => {
        const h = harness();
        const result = h.steering.steer('guide');
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
        expect(h.queue.cancelByLocalId('guide')).toBe('in-flight');
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        const drained = vi.fn();
        const drain = h.steering.drain().then(drained);
        await Promise.resolve();
        expect(drained).not.toHaveBeenCalled();
        h.admission.resolve({ kind: 'accepted' });
        expect(await result).toEqual({ steered: true });
        await drain;
        expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, sessionId: 'ses_test' }), 'guide', 'guidance');
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['guide'], { steered: true });
        expect(h.queue.cancelByLocalId('guide')).toBe('consumed');
        expect(h.queue.queue.map(item => item.localId)).toEqual(['before', 'after']);
    });

    it.each(['endTurn', 'nextTurn'] as const)('restores FIFO order when %s happens before dispatch', async change => {
        const h = harness();
        h.client.setSteerDeliveryState.mockImplementationOnce(async () => { h[change](); return true; });
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.send).not.toHaveBeenCalled();
        expect(h.queue.queue.map(item => item.localId)).toEqual(['before', 'guide', 'after']);
        expect(h.client.setSteerDeliveryState).toHaveBeenLastCalledWith(['guide'], 'queued');
    });

    it('does not submit a reservation cancelled before dispatch', async () => {
        const h = harness();
        h.client.setSteerDeliveryState.mockImplementationOnce(async () => {
            expect(h.queue.cancelByLocalId('guide')).toBe(true);
            return true;
        });
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.send).not.toHaveBeenCalled();
        expect(h.queue.peekByLocalId('guide')).toBeNull();
        expect(h.client.setSteerDeliveryState).toHaveBeenCalledExactlyOnceWith(['guide'], 'dispatching');
        expect(h.client.emitSteerIndeterminate).not.toHaveBeenCalled();
    });

    it('settles the hub row without requeuing guidance cleared by Stop before native dispatch', async () => {
        const h = harness();
        h.client.setSteerDeliveryState.mockImplementationOnce(async () => {
            h.endTurn();
            h.steering.interrupt();
            h.queue.reset({ preserveDispatchingReservations: true });
            return true;
        });
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.send).not.toHaveBeenCalled();
        expect(h.queue.size()).toBe(0);
        expect(h.client.setSteerDeliveryState).toHaveBeenLastCalledWith(['guide'], 'queued');
        expect(h.client.emitSteerIndeterminate).not.toHaveBeenCalled();
    });

    it('holds the hub row when Stop removes the reservation and restoring durable queue state fails', async () => {
        const h = harness();
        h.client.setSteerDeliveryState.mockImplementationOnce(async () => {
            h.endTurn();
            h.steering.interrupt();
            h.queue.reset({ preserveDispatchingReservations: true });
            return true;
        }).mockResolvedValueOnce(false);
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.send).not.toHaveBeenCalled();
        expect(h.queue.size()).toBe(0);
        expect(h.client.setSteerDeliveryState).toHaveBeenLastCalledWith(['guide'], 'queued');
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledExactlyOnceWith(['guide']);
    });

    it('preserves earlier delivery ambiguity when Stop cancels an explicit retry before dispatch', async () => {
        const h = harness();
        h.admission.resolve({ kind: 'indeterminate', error: 'lost reply' });
        await h.steering.steer('guide');
        h.client.setSteerDeliveryState.mockImplementationOnce(async () => {
            h.endTurn();
            h.steering.interrupt();
            h.queue.reset({ preserveDispatchingReservations: true });
            return true;
        });
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.send).toHaveBeenCalledOnce();
        expect(h.queue.size()).toBe(0);
        expect(h.client.setSteerDeliveryState.mock.calls).toEqual([
            [['guide'], 'dispatching'],
            [['guide'], 'dispatching'],
        ]);
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledTimes(2);
    });

    it('preserves an admission receipt when Stop happens during the POST', async () => {
        const h = harness();
        const result = h.steering.steer('guide');
        await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
        h.endTurn();
        h.steering.interrupt();
        h.queue.reset({ preserveDispatchingReservations: true });
        h.admission.resolve({ kind: 'accepted' });
        expect(await result).toEqual({ steered: true });
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['guide'], { steered: true });
        expect(h.queue.size()).toBe(0);
    });

    it('does not requeue a late rejection after Stop cleared the queue', async () => {
        const h = harness();
        const result = h.steering.steer('guide');
        await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
        h.endTurn();
        h.steering.interrupt();
        h.queue.reset({ preserveDispatchingReservations: true });
        h.admission.resolve({ kind: 'rejected', error: 'rejected' });
        expect(await result).toMatchObject({ steered: false });
        expect(h.queue.size()).toBe(0);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
    });

    it('restores a definite rejection without losing FIFO order', async () => {
        const h = harness();
        h.admission.resolve({ kind: 'rejected', error: 'rejected' });
        expect(await h.steering.steer('guide')).toEqual({ steered: false, error: 'rejected' });
        expect(h.queue.queue.map(item => item.localId)).toEqual(['before', 'guide', 'after']);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
    });

    it('holds uncertain delivery outside automatic replay, including an explicitly retried rejection', async () => {
        const h = harness();
        h.admission.resolve({ kind: 'indeterminate', error: 'lost reply' });
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['guide']);
        expect(h.queue.peekByLocalId('guide')).toBeNull();
        h.send.mockResolvedValueOnce({ kind: 'rejected', error: 'already exists' });
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.queue.peekByLocalId('guide')).toBeNull();
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        expect(h.queue.releaseIndeterminateReservation('guide')).toBe(true);
    });

    it('does not submit when durable dispatch state cannot be confirmed', async () => {
        const h = harness();
        h.client.setSteerDeliveryState.mockResolvedValueOnce(false);
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.send).not.toHaveBeenCalled();
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledExactlyOnceWith(['guide']);
    });

    it('holds a rejected steer if restoring the hub queue cannot be confirmed', async () => {
        const h = harness();
        h.admission.resolve({ kind: 'rejected', error: 'rejected' });
        h.client.setSteerDeliveryState.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        await h.steering.steer('guide');
        expect(h.queue.peekByLocalId('guide')).toBeNull();
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['guide']);
    });

    it.each(['compact', 'clear'] as const)('does not inject /%s control operations', async operation => {
        const h = harness();
        h.queue.pushIsolated(`/${operation}`, { ...h.mode, operation }, 'control');
        expect(await h.steering.steer('control')).toMatchObject({ steered: false });
        expect(h.queue.peekByLocalId('control')).not.toBeNull();
        expect(h.send).not.toHaveBeenCalled();
    });

    it('does not inject a message with different model, effort or permission settings', async () => {
        const h = harness();
        h.queue.push('different settings', { ...h.mode, modelReasoningEffort: 'high' }, 'different');
        expect(await h.steering.steer('different')).toMatchObject({ steered: false });
        expect(h.queue.peekByLocalId('different')).not.toBeNull();
        expect(h.send).not.toHaveBeenCalled();
    });

    it('keeps idle-session messages queued', async () => {
        const h = harness();
        h.endTurn();
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.queue.size()).toBe(3);
        expect(h.send).not.toHaveBeenCalled();
    });
});
