import { AgentSessionBase, type AgentSessionBaseOptions } from '@/agent/sessionBase'
import type { HermesPermissionMode } from '@hapi/protocol'

export type HermesMode = Record<string, never>

export class HermesSession extends AgentSessionBase<HermesMode> {
    constructor(options: Pick<AgentSessionBaseOptions<HermesMode>, 'api' | 'client' | 'path' | 'logPath' | 'sessionId' | 'messageQueue' | 'permissionMode' | 'model'>) {
        super({
            ...options,
            mode: 'remote',
            onModeChange: () => {},
            sessionLabel: 'HermesSession',
            sessionIdLabel: 'Hermes',
            applySessionIdToMetadata: (metadata, sessionId) => ({ ...metadata, hermesSessionId: sessionId })
        })
    }

    setPermissionMode(mode: HermesPermissionMode): void { this.permissionMode = mode }
    setModel(model: string | null): void { this.model = model }
}
