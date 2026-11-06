import { BasePermissionHandler, type PendingPermissionRequest, type PermissionCompletion, type PermissionHandlerClient } from '@/modules/common/permission/BasePermissionHandler';
import { randomUUID } from 'node:crypto';
import { normalizeAgyTool } from '../messages';
import type { AgyNativeStep, AgyTranscriptSource } from './transcript';
import type { AgyProcess } from './nativeProcess';
import { permissionOption } from './nativeProcess';
import type { AgyTerminalPermission } from './terminalState';

type Response = {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
};
type Request = { step: AgyNativeStep; menu: AgyTerminalPermission; signature: string };

function signature(step: AgyNativeStep): string {
    return JSON.stringify([step.index, step.tool?.id, step.tool?.name, step.tool?.input, step.permission]);
}

function presentation(step: AgyNativeStep) {
    return normalizeAgyTool({ type: 'tool_call', id: step.tool!.id, name: step.tool!.name, input: step.tool!.input, status: 'pending' });
}

// Native wraps long targets at the terminal width. This is only a visual
// correlation; decisions also re-read the exact DB identity, arguments and
// request under the input lock. Ambiguous matches are never offered.
function visualTarget(text: string): string { return text.replace(/\s/g, ''); }

/** Native Auto remains in charge of automatic decisions. Only actual native
 * WAITING requests with a matching live menu enter HAPI's approval flow. */
export class AgyPtyPermissionHandler extends BasePermissionHandler<Response, void> {
    private readonly requests = new Map<string, Request>();
    private readonly responding = new Set<string>();
    private readonly sessionApprovals = new Set<string>();
    private closed = false;

    constructor(client: PermissionHandlerClient, private readonly process: AgyProcess, private readonly transcript: AgyTranscriptSource,
        private readonly isActive: () => boolean, private readonly abortTurn: () => Promise<void>, private readonly onError: (error: Error) => void) {
        super(client);
    }

    get pending(): boolean { return this.requests.size > 0 || this.responding.size > 0; }

    private grantKey(step: AgyNativeStep): string { return JSON.stringify([step.tool!.name, step.tool!.input]); }

    sync(steps: Iterable<AgyNativeStep>): void {
        if (this.closed) return;
        const waiting = [...steps].filter(step => step.status === 9 && step.permission && step.tool);
        for (const [id, request] of this.requests) {
            if (this.responding.has(id)) continue;
            if (!waiting.some(step => signature(step) === request.signature)) this.cancel(id, 'Antigravity withdrew this approval');
        }
        const menu = this.process.state.permission;
        if (this.process.state.kind !== 'permission' || !menu || !this.isActive()) return;
        const matching = waiting.filter(step => step.permission?.kind === 'permission'
            && visualTarget(step.permission.target) === visualTarget(menu.target));
        if (matching.length !== 1 || permissionOption(menu, true) === null || permissionOption(menu, false) === null) return;
        const step = matching[0]!;
        if ([...this.requests.values()].some(request => request.signature === signature(step))) return;
        // A resumed native tool can reuse its call ID. A fresh reply ID prevents
        // an old button click from answering a new process's request.
        const id = `agy-permission-${randomUUID()}`;
        const request: Request = { step, menu, signature: signature(step) };
        this.requests.set(id, request);
        const tool = presentation(step);
        this.addPendingRequest(id, tool.name, tool.input, { resolve: () => {}, reject: () => {} }, { toolCallId: step.tool!.id });
        if (this.sessionApprovals.has(this.grantKey(step))) {
            this.pendingRequests.delete(id);
            void this.handlePermissionResponse({ id, approved: true, decision: 'approved_for_session' },
                { toolName: tool.name, input: tool.input, resolve: () => {}, reject: () => {} })
                .then(completion => this.finalizeRequest(id, completion));
        }
    }

    private async current(request: Request): Promise<boolean> {
        if (this.closed || !this.isActive() || this.process.failure) return false;
        const [step] = await this.transcript.read(request.step.index);
        return Boolean(step && signature(step) === request.signature && step.status === 9);
    }

    protected async handlePermissionResponse(response: Response, pending: PendingPermissionRequest<void>): Promise<PermissionCompletion> {
        const request = this.requests.get(response.id);
        const decision = response.decision ?? (response.approved ? 'approved' : 'denied');
        if (!request || this.responding.has(response.id)) return { status: 'canceled', decision: 'abort' };
        this.responding.add(response.id);
        try {
            if (!await this.current(request)) return { status: 'canceled', decision: 'abort' };
            if (decision === 'abort') {
                await this.abortTurn();
                return { status: 'canceled', decision: 'abort', reason: response.reason };
            }
            const approved = decision === 'approved' || decision === 'approved_for_session';
            await this.process.respond(request.menu, approved, () => this.current(request));
            // A key write is not a recorded native approval. Confirm it once;
            // an uncertain decision is never sent again automatically.
            const deadline = Date.now() + 5_000;
            while (!this.closed && this.isActive() && !this.process.failure && Date.now() < deadline) {
                const [step] = await this.transcript.read(request.step.index);
                if (!step || step.tool?.id !== request.step.tool?.id) break;
                if (step.decision) {
                    if (step.decision.approved !== approved) break;
                    if (decision === 'approved_for_session') this.sessionApprovals.add(this.grantKey(request.step));
                    return { status: approved ? 'approved' : 'denied', decision, reason: response.reason };
                }
                await this.process.waitForChange();
            }
            throw new Error('Antigravity did not confirm this approval decision');
        } catch (error) {
            // A withdrawn request or a late click must not stop a newer native
            // operation. Report failures only while this exact request survives.
            if (await this.current(request).catch(() => false)) {
                this.onError(error instanceof Error ? error : new Error(String(error)));
            }
            return { status: 'canceled', decision: 'abort', reason: 'Native approval could not be confirmed' };
        } finally {
            this.requests.delete(response.id);
            this.responding.delete(response.id);
            pending.resolve();
        }
    }

    protected handleMissingPendingResponse(): void {}

    private cancel(id: string, reason: string): void {
        this.requests.delete(id);
        this.pendingRequests.delete(id);
        this.finalizeRequest(id, { status: 'canceled', reason, decision: 'abort' });
    }

    cancelAll(reason: string): void { for (const id of [...this.requests.keys()]) this.cancel(id, reason); }

    close(): void {
        this.closed = true;
        this.sessionApprovals.clear();
        this.cancelAll('Antigravity process stopped');
    }
}
