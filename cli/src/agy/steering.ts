import { AgyIndeterminateDeliveryError } from './pty/delivery';
import type { QueueReservation } from '@/utils/MessageQueue2';
import type { AgySession } from './session';
import type { AgyMode } from './types';

export type AgySteerResult = { steered: boolean; error?: string };
export type AgySteerTarget = {
    isActive: () => boolean;
    send: (text: string) => { dispatched: Promise<void>; completed: Promise<unknown> };
};
type Delivery = {
    localId: string;
    reservation: QueueReservation<AgyMode>;
    target: AgySteerTarget;
    text: string;
    echo: string;
    submitted: boolean;
    received: boolean;
};

/** agy echoes text without client IDs. Serialize unacknowledged injections so
 * one exact echo identifies one delivery; never replay uncertain input. */
export class AgySteering {
    private target: AgySteerTarget | null = null;
    private receipt: Delivery | null = null;
    private readonly pending = new Set<Promise<void>>();
    private active = false;

    constructor(private readonly session: AgySession) {}

    setTarget(target: AgySteerTarget | null): void {
        this.target = target;
        const active = target !== null;
        if (active === this.active) return;
        this.active = active;
        this.session.client.updateAgentState(state => ({ ...state, steeringActive: active }));
    }

    acknowledge(target: AgySteerTarget, text: string): void {
        const delivery = this.receipt;
        if (!delivery || delivery.target !== target || !delivery.submitted || delivery.received) return;
        const echo = delivery.echo + text;
        if (!delivery.text.startsWith(echo)) return;
        delivery.echo = echo;
        if (echo !== delivery.text) return;
        delivery.received = true;
        this.receipt = null;
        if (this.session.queue.commitReservation(delivery.reservation)) {
            this.session.client.emitMessagesConsumed([delivery.localId], { steered: true });
        }
    }

    steer(localId: string): Promise<AgySteerResult> {
        const target = this.target;
        if (!localId || !target || !target.isActive()) return Promise.resolve({ steered: false, error: 'No active Antigravity turn' });
        if (this.receipt) return Promise.resolve({ steered: false, error: 'Waiting for Antigravity to acknowledge the previous guidance' });
        const reservation = this.session.queue.takeByLocalId(localId);
        if (!reservation) return Promise.resolve({ steered: false, error: 'Message is no longer queued or is already being steered' });
        const text = reservation.item.message;
        if (reservation.originIndeterminate || reservation.item.isolate || !text.trim() || /^\s*\//.test(text)) {
            this.session.queue.restoreReservation(reservation);
            return Promise.resolve({ steered: false, error: reservation.originIndeterminate
                ? 'Previous delivery is uncertain; resolve it with Cancel or Retry in the queue'
                : 'Steer requires guidance text; commands stay queued' });
        }
        if (!this.session.queue.beginReservationDispatch(reservation)) {
            return Promise.resolve({ steered: false, error: 'Steer was cancelled' });
        }
        const delivery: Delivery = { localId, reservation, target, text, echo: '', submitted: false, received: false };
        this.receipt = delivery;
        let respond!: (result: AgySteerResult) => void;
        const response = new Promise<AgySteerResult>(resolve => { respond = resolve; });
        const work = this.dispatch(delivery, respond);
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work));
        return response;
    }

    private hold(delivery: Delivery): void {
        if (delivery.received) return;
        if (this.session.queue.markReservationIndeterminate(delivery.reservation)
            || delivery.reservation.cancelReason === 'queue-reset') {
            this.session.client.emitSteerIndeterminate([delivery.localId]);
        }
    }

    private async restore(delivery: Delivery): Promise<void> {
        if (delivery.received) return;
        if (delivery.reservation.state === 'dispatching'
            && await this.session.client.setSteerDeliveryState([delivery.localId], 'queued')) {
            if (!this.session.queue.restoreReservation(delivery.reservation)) this.hold(delivery);
        } else this.hold(delivery);
    }

    private async dispatch(delivery: Delivery, respond: (result: AgySteerResult) => void): Promise<void> {
        try {
            if (!await this.session.client.setSteerDeliveryState([delivery.localId], 'dispatching')) {
                this.hold(delivery);
                respond({ steered: false, error: 'Could not confirm steer delivery state; retry explicitly' });
                return;
            }
            if (this.target !== delivery.target || !delivery.target.isActive() || delivery.reservation.state !== 'dispatching') {
                await this.restore(delivery);
                respond({ steered: false, error: 'The active Antigravity turn changed before dispatch' });
                return;
            }
            delivery.submitted = true;
            const request = delivery.target.send(delivery.text);
            void request.completed.catch(() => {});
            await request.dispatched;
            // Dispatch can be quick while a tool delays the native receipt. Keep
            // the durable row pending until a native receipt arrives.
            respond({ steered: true });
            await request.completed;
            this.hold(delivery);
        } catch (error) {
            if (error instanceof AgyIndeterminateDeliveryError) this.hold(delivery);
            else {
                try { await this.restore(delivery); } catch { this.hold(delivery); }
            }
            const message = error instanceof Error ? error.message : String(error);
            this.session.client.sendSessionEvent({ type: 'message', message: `Antigravity steer: ${message}` });
            respond({ steered: false, error: message });
        } finally {
            if (this.receipt === delivery) this.receipt = null;
        }
    }

    async drain(): Promise<void> {
        while (this.pending.size) await Promise.all([...this.pending]);
    }
}
