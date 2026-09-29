import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types'
import { deriveToolInput, deriveToolName } from '@/agent/utils'
import {
    BasePermissionHandler,
    type PermissionHandlerClient,
    type PermissionCompletion,
    type PendingPermissionRequest
} from '@/modules/common/permission/BasePermissionHandler'

type Response = { id: string; approved: boolean; decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort' }

export function hermesPermissionOutcome(request: PermissionRequest, decision: Response['decision']): PermissionResponse {
    // Hermes gives session and permanent grants the same ACP kind. Select the
    // native id explicitly so "for session" never writes permanent approvals.
    const id = decision === 'approved_for_session' ? 'allow_session'
        : decision === 'approved' ? 'allow_once'
            : decision === 'denied' ? 'deny' : null
    const option = request.options.find(option => option.optionId === id)
        ?? (decision === 'approved_for_session' ? request.options.find(option => option.optionId === 'allow_once') : undefined)
    return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' }
}

/** Hermes owns edit policy; every request that reaches HAPI still needs an answer. */
export class HermesPermissionHandler extends BasePermissionHandler<Response, void> {
    private readonly backendRequests = new Map<string, PermissionRequest>()
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

    constructor(client: PermissionHandlerClient, private readonly backend: AgentBackend) {
        super(client)
        backend.onPermissionRequest(request => {
            this.backendRequests.set(request.id, request)
            this.addPendingRequest(request.id, deriveToolName(request), deriveToolInput(request), {
                resolve: () => {}, reject: () => {}
            })
            // Bound HAPI approvals to one minute. Native completion/withdrawal
            // can expire them sooner; a late browser answer must never authorize a tool.
            this.timers.set(request.id, setTimeout(() => { void this.expire(request.id) }, 60_000))
        })
    }

    private take(id: string): PermissionRequest | undefined {
        clearTimeout(this.timers.get(id))
        this.timers.delete(id)
        const request = this.backendRequests.get(id)
        this.backendRequests.delete(id)
        return request
    }

    private async expire(id: string, reason = 'Hermes approval timed out'): Promise<void> {
        const request = this.take(id)
        this.pendingRequests.delete(id)
        this.finalizeRequest(id, { status: 'canceled', reason, decision: 'abort' })
        if (request) await this.backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' })
    }

    protected async handlePermissionResponse(response: Response, pending: PendingPermissionRequest<void>): Promise<PermissionCompletion> {
        const request = this.take(response.id)
        const decision = response.decision ?? (response.approved ? 'approved' : 'denied')
        const outcome = request ? hermesPermissionOutcome(request, decision) : { outcome: 'cancelled' } as const
        if (request) {
            await this.backend.respondToPermission(request.sessionId, request, outcome)
            if (decision === 'abort') await this.backend.cancelPrompt(request.sessionId)
        }
        pending.resolve()
        return {
            status: outcome.outcome === 'cancelled' ? 'canceled' : decision === 'denied' ? 'denied' : 'approved',
            decision: decision === 'approved_for_session' && outcome.outcome === 'selected' && outcome.optionId === 'allow_once' ? 'approved' : decision
        }
    }

    async onToolCompleted(id: string): Promise<void> {
        if (this.backendRequests.has(id)) await this.expire(id, 'Hermes withdrew this approval')
    }

    protected handleMissingPendingResponse(): void {}

    async cancelAll(reason: string): Promise<void> {
        const requests = [...this.backendRequests.keys()].map(id => this.take(id)!)
        this.cancelPendingRequests({ completedReason: reason, rejectMessage: reason, decision: 'abort' })
        await Promise.all(requests.map(request => this.backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' })))
    }
}
