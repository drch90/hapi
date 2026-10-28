import { describe, expect, it } from 'vitest'
import { normalizeClaudeSessionModel, parseClaudeModelCommand } from './model'

describe('normalizeClaudeSessionModel', () => {
    it('returns null when model is missing', () => {
        expect(normalizeClaudeSessionModel()).toBeNull()
    })

    it('returns null for auto-like values', () => {
        expect(normalizeClaudeSessionModel('')).toBeNull()
        expect(normalizeClaudeSessionModel('auto')).toBeNull()
        expect(normalizeClaudeSessionModel('default')).toBeNull()
    })

    it('preserves Claude aliases and full model strings', () => {
        expect(normalizeClaudeSessionModel('sonnet')).toBe('sonnet')
        expect(normalizeClaudeSessionModel('opus[1m]')).toBe('opus[1m]')
        expect(normalizeClaudeSessionModel('claude-3-7-sonnet-latest')).toBe('claude-3-7-sonnet-latest')
        expect(normalizeClaudeSessionModel('  claude-opus-4-1-20250805  ')).toBe('claude-opus-4-1-20250805')
    })
})

describe('parseClaudeModelCommand', () => {
    it.each(['sonnet', 'opus[1m]', 'custom:office:qwen:32b', 'provider/model-2026'])('preserves the model ID in /model %s', (model) => {
        expect(parseClaudeModelCommand(` /model\t${model} `)).toBe(model)
    })

    it.each(['auto', 'default'])('recognizes an explicit reset to %s', (model) => {
        expect(parseClaudeModelCommand(`/model ${model}`)).toBeNull()
    })

    it.each(['/model', '/models sonnet', 'Use /model sonnet', '/model sonnet extra', '/model sonnet\nDo work', '/model\nsonnet'])('leaves other input intact: %s', (text) => {
        expect(parseClaudeModelCommand(text)).toBeUndefined()
    })
})
