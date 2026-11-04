import type { OpencodeSession } from './session';
import type { OpencodeMode } from './types';
import type { QueueReservation } from '@/utils/MessageQueue2';
import { sendOpencodeSteer, type OpencodeSteerTarget } from './utils/opencodeSteeringBridge';

export type OpencodeSteeringTurn = OpencodeSteerTarget & {
    generation: number;
    modeHash: string;
};

type SteerResult = { steered: boolean; error?: string };
type SteeringOptions = {
    send?: typeof sendOpencodeSteer;
    hashMode?: (mode: OpencodeMode) => string;
};

/** Holds native admission across foreground completion, Stop and remote teardown. */
export class OpencodeSteering {
    private readonly pending = new Set<Promise<SteerResult>>();
    private interruption = 0;
    private readonly send: typeof sendOpencodeSteer;
    private readonly hashMode: (mode: OpencodeMode) => string;

    constructor(
        private readonly session: Pick<OpencodeSession, 'queue' | 'client'>,
        private readonly currentTurn: () => OpencodeSteeringTurn | null,
        options: SteeringOptions = {},
    ) {
        this.send = options.send ?? sendOpencodeSteer;
        this.hashMode = options.hashMode ?? (mode => session.queue.modeHasher(mode));
    }

    async drain(): Promise<void> {
        while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    }

    interrupt(): void {
        this.interruption++;
    }

    steer(localId: string): Promise<SteerResult> {
        const turn = this.currentTurn();
        if (!localId || !turn) return Promise.resolve({ steered: false, error: 'No active steerable OpenCode turn' });
        const reservation = this.session.queue.takeByLocalId(localId);
        if (!reservation) return Promise.resolve({ steered: false, error: 'Message is no longer queued or is already being steered' });
        const item = reservation.item;
        if (item.isolate || item.mode.operation || item.message.trimStart().startsWith('/')) {
            this.session.queue.restoreReservation(reservation);
            return Promise.resolve({ steered: false, error: 'Control commands cannot be steered' });
        }
        if (this.hashMode(item.mode) !== turn.modeHash) {
            this.session.queue.restoreReservation(reservation);
            return Promise.resolve({ steered: false, error: 'Queued message mode differs from the active turn' });
        }
        const work = this.deliver(localId, turn, reservation);
        this.pending.add(work);
        void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
        return work;
    }

    private async deliver(localId: string, turn: OpencodeSteeringTurn, reservation: QueueReservation<OpencodeMode>): Promise<SteerResult> {
        const { queue, client } = this.session;
        const interruption = this.interruption;
        const hold = () => {
            if (reservation.state === 'cancelled') {
                // Stop can remove a reservation while its durable-state ACK is
                // pending. Settle the hub row even without a local reservation.
                if (reservation.cancelReason === 'queue-reset') client.emitSteerIndeterminate([localId]);
                return;
            }
            if (reservation.state === 'reserved') queue.beginReservationDispatch(reservation);
            if (queue.markReservationIndeterminate(reservation)) client.emitSteerIndeterminate([localId]);
        };
        const restore = async () => {
            // Explicit Cancel deletes the hub row; Stop only clears local input.
            if (reservation.state === 'cancelled' && reservation.cancelReason === 'explicit') return;
            if (reservation.originIndeterminate || !await client.setSteerDeliveryState([localId], 'queued')) {
                hold();
                return;
            }
            if (queue.restoreReservation(reservation) && interruption !== this.interruption) {
                // Stop clears queued input. A late definite rejection must not
                // reinsert that input into the launcher's automatic FIFO.
                queue.cancelByLocalId(localId);
            }
        };
        try {
            if (!await client.setSteerDeliveryState([localId], 'dispatching')) {
                hold();
                return { steered: false, error: 'Could not confirm steer state; retry explicitly' };
            }
            const current = this.currentTurn();
            if (reservation.state !== 'reserved' || !current || current.sessionId !== turn.sessionId
                || current.generation !== turn.generation || current.modeHash !== turn.modeHash) {
                await restore();
                return { steered: false, error: 'The active OpenCode turn changed' };
            }
            if (!queue.beginReservationDispatch(reservation)) return { steered: false, error: 'Steer cancelled' };
            const result = await this.send(turn, localId, reservation.item.message);
            if (result.kind === 'accepted') {
                // A native admission receipt remains valid even if Stop landed
                // during the request. It must never return to the HAPI queue.
                if (queue.commitReservation(reservation)) client.emitMessagesConsumed([localId], { steered: true });
                return { steered: true };
            }
            if (result.kind === 'indeterminate') hold();
            else await restore();
            return { steered: false, error: result.error };
        } catch {
            hold();
            return { steered: false, error: 'OpenCode steer delivery could not be confirmed' };
        }
    }
}
