import { createHash } from 'node:crypto';
import type { QueueReservation } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';
import type { SDKUserMessage } from './sdk';
import type { Session } from './session';

export type ClaudeSteerResult = { steered: boolean; error?: string };

/** A new identity for each turn; send returns false only before writing anything. */
export type ClaudeSteerTarget = {
    mode: EnhancedMode;
    send: (message: SDKUserMessage) => boolean;
};

type Delivery = {
    reservation: QueueReservation<EnhancedMode>;
    uuid: string;
    sent: boolean;
};

function messageUuid(sessionId: string, localId: string): string {
    // RFC 4122 v5: the durable hub identity also identifies a native stdin message.
    const bytes = createHash('sha1')
        .update(Buffer.from('55a58a27bb1c5f598d66920497a1cb9b', 'hex'))
        .update(JSON.stringify([sessionId, localId])).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Keeps unacknowledged input out of the normal queue, including across aborts. */
export class ClaudeSteering {
    private target: ClaudeSteerTarget | null = null;
    private active: boolean | undefined;
    private readonly deliveries = new Map<string, Delivery>();
    private readonly dispatches = new Set<Promise<ClaudeSteerResult>>();

    constructor(private readonly session: Session, private readonly flush: () => Promise<void>) {}

    setTarget(target: ClaudeSteerTarget | null): void {
        this.target = target;
        const active = target !== null;
        if (this.active === active) return;
        this.active = active;
        this.session.client.updateAgentState(state => ({ ...state, steeringActive: active }));
    }

    private matches(target: ClaudeSteerTarget): boolean {
        // Steer explicitly targets the running turn. The session selection and
        // a queued message's snapshot may already describe a subsequent turn.
        return this.target === target;
    }

    steer(localId: string): Promise<ClaudeSteerResult> {
        const { session, target } = this;
        const existing = this.deliveries.get(localId);
        if (existing) {
            const steered = existing.sent && existing.reservation.state === 'dispatching';
            return Promise.resolve({ steered, ...(!steered ? { error: 'Steer is already pending or its delivery is uncertain' } : {}) });
        }
        if (!localId || !target || !this.matches(target)) {
            return Promise.resolve({ steered: false, error: 'No active Claude turn' });
        }
        const reservation = session.queue.takeByLocalId(localId);
        if (!reservation) {
            return Promise.resolve({ steered: false, error: 'Message is no longer queued or is already being steered' });
        }
        const guidance = session.expandSkillReference(reservation.item.message);
        if (reservation.originIndeterminate) {
            session.queue.restoreReservation(reservation);
            return Promise.resolve({ steered: false, error: 'Previous delivery is uncertain; resolve it with Cancel or Retry in the queue' });
        }
        if (reservation.item.isolate || /^\s*\//.test(guidance) || !guidance.trim()) {
            session.queue.restoreReservation(reservation);
            return Promise.resolve({ steered: false, error: 'Steer requires guidance text; commands stay queued' });
        }
        if (!session.queue.beginReservationDispatch(reservation)) {
            return Promise.resolve({ steered: false, error: 'Steer was cancelled' });
        }
        const delivery: Delivery = { reservation, uuid: messageUuid(session.client.sessionId, localId), sent: false };
        this.deliveries.set(localId, delivery);

        const work = this.dispatch(localId, delivery, target, guidance);
        this.dispatches.add(work);
        void work.finally(() => this.dispatches.delete(work));
        return work;
    }

    private hold(localId: string, delivery: Delivery): void {
        if (this.session.queue.markReservationIndeterminate(delivery.reservation)
            || (delivery.reservation.state === 'cancelled' && delivery.reservation.cancelReason === 'queue-reset')) {
            this.session.client.emitSteerIndeterminate([localId]);
        }
    }

    private async restore(localId: string, delivery: Delivery): Promise<void> {
        if (delivery.reservation.state !== 'dispatching') {
            this.hold(localId, delivery);
            return;
        }
        if (await this.session.client.setSteerDeliveryState([localId], 'queued')) {
            if (!this.session.queue.restoreReservation(delivery.reservation)) this.hold(localId, delivery);
        } else {
            this.hold(localId, delivery);
        }
    }

    private async dispatch(localId: string, delivery: Delivery, target: ClaudeSteerTarget, guidance: string): Promise<ClaudeSteerResult> {
        try {
            if (!await this.session.client.setSteerDeliveryState([localId], 'dispatching')) {
                this.hold(localId, delivery);
                return { steered: false, error: 'Could not confirm steer delivery state; check the queue before retrying' };
            }
            if (delivery.reservation.state !== 'dispatching' || !this.matches(target)) {
                await this.restore(localId, delivery);
                return { steered: false, error: 'The active Claude turn changed before dispatch' };
            }
            // Once a write is attempted, failure is ambiguous. Only a matching
            // --replay-user-messages echo may stamp the hub row consumed.
            delivery.sent = true;
            const sent = target.send({ type: 'user', uuid: delivery.uuid, message: { role: 'user', content: guidance } });
            if (!sent) {
                delivery.sent = false;
                await this.restore(localId, delivery);
                return { steered: false, error: 'The active Claude turn ended before dispatch' };
            }
            // Return promptly: a tool can delay the native echo beyond the RPC
            // timeout. This acknowledges dispatch, never model consumption.
            return { steered: true };
        } catch (error) {
            this.hold(localId, delivery);
            return { steered: false, error: error instanceof Error ? error.message : 'Claude steer failed' };
        } finally {
            if (!delivery.sent) this.deliveries.delete(localId);
        }
    }

    async acknowledge(uuid: string): Promise<void> {
        const match = [...this.deliveries].find(([, delivery]) => delivery.sent && delivery.uuid === uuid);
        if (!match) return;
        const [localId, delivery] = match;
        this.deliveries.delete(localId);
        // Preserve transcript order: earlier tool output precedes the inserted
        // user row, and subsequent assistant output follows its consumed ACK.
        await this.flush();
        if (this.session.queue.commitReservation(delivery.reservation)) {
            this.session.client.emitMessagesConsumed([localId], { steered: true });
        }
    }

    /** Wait for pre-dispatch/restore work, never for a native echo. */
    async drain(): Promise<void> {
        while (this.dispatches.size) await Promise.all([...this.dispatches]);
    }

    async closeProcess(): Promise<void> {
        this.setTarget(null);
        await this.drain();
        for (const [localId, delivery] of this.deliveries) this.hold(localId, delivery);
        this.deliveries.clear();
    }
}
