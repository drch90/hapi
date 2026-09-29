import { asString, isObject, type HermesModelSummary, type HermesModelsResponse } from '@hapi/protocol'
import type { AcpSessionModelsMetadata } from '@/agent/backends/acp/AcpSdkBackend'

/** Choice IDs belong to Hermes. Never split custom:<provider>:<model> to route a request. */
export function hermesModels(source: AcpSessionModelsMetadata | undefined): HermesModelsResponse {
    if (!source) return { success: false, error: 'Hermes did not return a model catalog' }
    return { success: true, currentModelId: source.currentModelId, availableModels: source.availableModels.map(model => {
        const providerLabel = model.description?.match(/^Provider:\s*(.+?)(?:\s+[•·]\s+|$)/)?.[1]?.trim()
        return { ...model, ...(providerLabel ? { providerLabel } : {}) }
    }) }
}

export function parseHermesModelsResponse(response: unknown): HermesModelsResponse {
    if (!isObject(response) || !isObject(response.models)) {
        return { success: false, error: 'Hermes did not return a model catalog' }
    }
    const availableModels: HermesModelSummary[] = []
    for (const entry of Array.isArray(response.models.availableModels) ? response.models.availableModels : []) {
        if (!isObject(entry)) continue
        const modelId = asString(entry.modelId)
        if (modelId) availableModels.push({ modelId, name: asString(entry.name) ?? undefined, description: asString(entry.description) ?? undefined })
    }
    return hermesModels({ availableModels, currentModelId: asString(response.models.currentModelId) })
}

export function resolveHermesModel(input: string, models: readonly HermesModelSummary[]): string {
    const value = input.trim()
    if (!value || value === 'auto') throw new Error('Select a Hermes model or enter its complete model ID')
    if (models.some(model => model.modelId === value)) return value
    const matches = models.filter(model => model.name === value || model.modelId.endsWith(`:${value}`))
    if (matches.length > 1) throw new Error(`Multiple providers offer this model. Use its complete ID: ${matches.map(model => model.modelId).join(', ')}`)
    return matches[0]?.modelId ?? value
}

/** Hermes normalizes named endpoints to `custom` on its running agent. Keep the
 * accepted opaque choice when load confirms its model but omits provider identity.
 * A different native model/provider always wins. No model ID is split for routing.
 */
export function confirmedHermesModel(source: AcpSessionModelsMetadata, acceptedChoice?: string | null): string | null {
    const current = source.currentModelId
    const choice = source.availableModels.find(row => row.modelId === acceptedChoice)
    if (choice?.name && choice.modelId.startsWith('custom:') && current === `custom:${choice.name}`) {
        return choice.modelId
    }
    return current
}
