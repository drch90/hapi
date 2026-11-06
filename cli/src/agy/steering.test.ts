import { describe, expect, it, vi } from 'vitest';
import { AgySteering, type AgySteerTarget } from './steering';
import { AgyIndeterminateDeliveryError } from './pty/delivery';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { AgyMode } from './types';
import type { AgySession } from './session';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}

function harness() {
    const queue = new MessageQueue2<AgyMode>(mode => JSON.stringify(mode));
    const client = { updateAgentState: vi.fn(), setSteerDeliveryState: vi.fn(async () => true), emitMessagesConsumed: vi.fn(),
        emitSteerIndeterminate: vi.fn(), sendSessionEvent: vi.fn() };
    const completed = deferred<void>();
    const target: AgySteerTarget = { isActive: vi.fn(() => true),
        send: vi.fn(() => ({ dispatched: Promise.resolve(), completed: completed.promise })) };
    const steering = new AgySteering({ queue, client } as unknown as AgySession);
    steering.setTarget(target);
    const push = (text: string, id = 'guide') => queue.push(text, { permissionMode: 'auto' }, id);
    return { queue, client, steering, target, completed, push };
}

describe('Antigravity durable steer delivery', () => {
    it('acknowledges one exact receipt and serializes unacknowledged sends', async () => {
        const h = harness(); h.push('new direction');
        expect(await h.steering.steer('guide')).toEqual({ steered: true });
        h.push('next', 'second');
        expect(await h.steering.steer('second')).toMatchObject({ steered: false });
        h.steering.acknowledge(h.target, 'unrelated');
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        h.steering.acknowledge(h.target, 'new direction');
        h.steering.acknowledge(h.target, 'new direction');
        expect(h.client.emitMessagesConsumed).toHaveBeenCalledExactlyOnceWith(['guide'], { steered: true });
        h.completed.resolve(); await h.steering.drain();
        expect(h.client.emitSteerIndeterminate).not.toHaveBeenCalled();
    });

    it('holds input when the process ends after dispatch without a native receipt', async () => {
        const h = harness(); h.push('uncertain');
        await h.steering.steer('guide');
        h.completed.reject(new AgyIndeterminateDeliveryError('Native process stopped'));
        await h.steering.drain();
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['guide']);
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.target.send).toHaveBeenCalledOnce();
    });

    it('does not infer receipt from a successful delivery promise', async () => {
        const h = harness(); h.push('guide');
        await h.steering.steer('guide'); h.completed.resolve(); await h.steering.drain();
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['guide']);
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
    });

    it('restores a reservation if the active turn changes before input is written', async () => {
        const h = harness(); h.push('guide');
        const persisted = deferred<boolean>();
        h.client.setSteerDeliveryState.mockReturnValueOnce(persisted.promise);
        const result = h.steering.steer('guide');
        h.steering.setTarget(null); persisted.resolve(true);
        expect(await result).toMatchObject({ steered: false });
        await h.steering.drain();
        expect(h.target.send).not.toHaveBeenCalled();
        expect(h.client.setSteerDeliveryState).toHaveBeenLastCalledWith(['guide'], 'queued');
        expect(h.queue.peekByLocalId('guide')?.message).toBe('guide');
    });

    it('does not write guidance if its durable dispatch state could not be confirmed', async () => {
        const h = harness(); h.push('guide'); h.client.setSteerDeliveryState.mockResolvedValueOnce(false);
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        await h.steering.drain();
        expect(h.target.send).not.toHaveBeenCalled();
        expect(h.client.emitSteerIndeterminate).toHaveBeenCalledWith(['guide']);
    });

    it('keeps terminal commands queued and ignores stale receipts from an earlier target', async () => {
        const h = harness(); h.push('/model different');
        expect(await h.steering.steer('guide')).toMatchObject({ steered: false });
        expect(h.queue.peekByLocalId('guide')).toBeDefined();
        h.push('real guidance', 'text'); await h.steering.steer('text');
        h.steering.acknowledge({ ...h.target }, 'real guidance');
        expect(h.client.emitMessagesConsumed).not.toHaveBeenCalled();
        h.steering.acknowledge(h.target, 'real guidance'); h.completed.resolve(); await h.steering.drain();
    });
});
