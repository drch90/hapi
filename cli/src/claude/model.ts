import type { SessionModel } from '@/api/types'

export function normalizeClaudeSessionModel(model?: string | null): SessionModel {
    const trimmedModel = model?.trim()
    if (!trimmedModel || trimmedModel === 'auto' || trimmedModel === 'default') {
        return null
    }

    return trimmedModel
}

/** A complete model-setting command; bare /model remains available to the CLI. */
export function parseClaudeModelCommand(message: string): SessionModel | undefined {
    const match = /^\/model[\t ]+(\S+)[\t ]*$/.exec(message.trim())
    return match ? normalizeClaudeSessionModel(match[1]) : undefined
}
