import type { AcpSdkBackend } from '@/agent/backends/acp/AcpSdkBackend'
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import type { HermesSession } from './session'
import { parseHermesCommand } from './commands'

type SteerResult = { steered: boolean; error?: string }

/** Concurrent prompts retain the foreground stream handler and hold the next turn until settled. */
export class HermesSteering {
    private pending = new Set<Promise<void>>()

    constructor(private readonly session: HermesSession, private readonly backend: AcpSdkBackend,
        private readonly isActive: () => boolean) {}

    get busy(): boolean { return this.pending.size > 0 }

    async drain(): Promise<void> {
        while (this.pending.size) await Promise.all([...this.pending])
    }

    steer(localId: string): Promise<SteerResult> {
        const { session, backend } = this
        const id = session.sessionId
        if (!localId || !id || !this.isActive()) return Promise.resolve({ steered: false, error: 'No active steerable Hermes turn' })
        const reservation = session.queue.takeByLocalId(localId)
        if (!reservation) return Promise.resolve({ steered: false, error: 'Message is no longer queued or is already being steered' })
        const command = parseHermesCommand(reservation.item.message)
        const guidance = command?.name === 'steer' ? command.args : reservation.item.message
        if ((command && command.name !== 'steer') || !guidance.trim()) {
            session.queue.restoreReservation(reservation)
            return Promise.resolve({ steered: false, error: 'Only guidance can be steered; use /steer <guidance>' })
        }
        const generation = backend.getPromptGeneration()
        let respond!: (result: SteerResult) => void
        const response = new Promise<SteerResult>(resolve => { respond = resolve })
        const hold = () => {
            session.queue.markReservationIndeterminate(reservation)
            session.client.emitSteerIndeterminate([localId])
        }
        const restore = async () => {
            if (reservation.state === 'cancelled') return
            if (reservation.originIndeterminate || !await session.client.setSteerDeliveryState([localId], 'queued')) { hold(); return }
            session.queue.restoreReservation(reservation)
        }
        const work = (async () => {
            try {
                if (!session.queue.beginReservationDispatch(reservation)) throw new Error('Steer canceled')
                if (!await session.client.setSteerDeliveryState([localId], 'dispatching')) {
                    hold()
                    respond({ steered: false, error: 'Could not confirm steer state; retry explicitly' })
                    return
                }
                if (reservation.state !== 'dispatching' || !this.isActive() || backend.getPromptGeneration() !== generation) {
                    await restore()
                    respond({ steered: false, error: 'The active Hermes turn changed' })
                    return
                }
                const request = backend.beginSoftSteerPrompt(id, [{ type: 'text', text: `/steer ${guidance}` }])
                // Attach rejection handling before awaiting dispatch.
                void request.completed.catch(() => {})
                await request.dispatched
                respond({ steered: true })
                await request.completed
                if (session.queue.commitReservation(reservation)) {
                    session.client.emitMessagesConsumed([localId], { steered: true })
                }
            } catch (error) {
                try {
                    if (isAcpIndeterminateError(error)) hold()
                    else await restore()
                } catch { hold() }
                const message = error instanceof Error ? error.message : 'Hermes steer failed'
                session.client.sendSessionEvent({ type: 'message', message: `Hermes steer: ${message}` })
                respond({ steered: false, error: message })
            }
        })()
        this.pending.add(work)
        void work.finally(() => this.pending.delete(work))
        return response
    }
}
