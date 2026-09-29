import { describe, expect, it } from 'vitest'
import { confirmedHermesModel, hermesModels, parseHermesModelsResponse, resolveHermesModel } from './models'
import { hermesCommands, parseHermesCommand } from './commands'

describe('Hermes models and commands', () => {
    const models = [
        { modelId: 'custom:office:qwen:32b', name: 'qwen:32b', description: 'Provider: Office • current' },
        { modelId: 'custom:home:qwen:32b', name: 'qwen:32b', description: 'Provider: Home' }
    ]
    it('keeps custom provider identity, including colons inside the model', () => {
        const result = hermesModels({ availableModels: models, currentModelId: models[0].modelId })
        expect(result.availableModels?.map(model => model.providerLabel)).toEqual(['Office', 'Home'])
        expect(result.availableModels?.map(model => model.modelId)).toEqual(models.map(model => model.modelId))
        expect(resolveHermesModel(models[1].modelId, models)).toBe(models[1].modelId)
        expect(() => resolveHermesModel('qwen:32b', models)).toThrow('Multiple providers')
        expect(resolveHermesModel('qwen:32b', [models[0]])).toBe(models[0].modelId)
    })
    it('reports missing metadata and preserves a genuinely empty catalog', () => {
        expect(parseHermesModelsResponse({}).success).toBe(false)
        expect(parseHermesModelsResponse({ models: { availableModels: [], currentModelId: '' } })).toEqual({ success: true, availableModels: [], currentModelId: '' })
        expect(hermesModels({ availableModels: [{ modelId: 'opaque:id' }], currentModelId: 'opaque:id' }).availableModels).toEqual([{ modelId: 'opaque:id' }])
    })
    it('retains an accepted named endpoint only when native state confirms that model with generic custom identity', () => {
        const source = { availableModels: models, currentModelId: 'custom:qwen:32b' }
        expect(confirmedHermesModel(source, models[0].modelId)).toBe(models[0].modelId)
        expect(confirmedHermesModel(source, models[1].modelId)).toBe(models[1].modelId)
        expect(confirmedHermesModel(source)).toBe('custom:qwen:32b')
        expect(confirmedHermesModel({ ...source, currentModelId: models[1].modelId }, models[0].modelId)).toBe(models[1].modelId)
        expect(confirmedHermesModel({ ...source, currentModelId: 'custom:different' }, models[0].modelId)).toBe('custom:different')
        expect(confirmedHermesModel({ ...source, currentModelId: null }, models[0].modelId)).toBeNull()
    })
    it('isolates supported commands and filters the native queue command', () => {
        expect(hermesCommands().map(row => row.name)).toEqual(['help', 'model', 'tools', 'context', 'reset', 'compress', 'version', 'steer'])
        expect(hermesCommands([{ name: 'queue' }, { name: 'steer', inputHint: 'guidance' }]).map(row => row.name)).toEqual(['help', 'steer'])
        expect(parseHermesCommand('/MODEL custom:office:qwen:32b')).toEqual({ name: 'model', args: 'custom:office:qwen:32b' })
        expect(parseHermesCommand('explain /model')).toBeNull()
    })
})
