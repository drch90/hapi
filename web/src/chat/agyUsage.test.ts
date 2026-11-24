import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import type { NormalizedMessage } from './types'

function wire(id: string, content: unknown, seq: number): NormalizedMessage {
    return normalizeDecryptedMessage({ id, seq, localId: null, createdAt: seq, content })!
}
const prose = (id: string, seq: number) => wire(id, { role: 'agent', content: { type: 'output', data: {
    type: 'agy_message', id, content: id, model: 'gemini-test',
} } }, seq)
const summary = (id: string, requestId: string, seq: number) => wire(id, { role: 'agent', content: { type: 'codex', data: {
    type: 'round-summary', summary: { provider: 'agy', conversation_id: 'native', request_id: requestId,
        model: 'gemini-test', num_turns: 1,
        agy_usage: { input_tokens: 120, output_tokens: 50, cache_read_tokens: 40, cache_write_tokens: 10, thinking_tokens: 20, total_tokens: 220 },
    },
} } }, seq)

describe('native Antigravity request usage', () => {
    it('retains calls without prose until a response block exists, without leaking into the next user turn', () => {
        const result = reduceChatBlocks([summary('usage-1', 'call-1', 1), summary('usage-2', 'call-2', 2),
            prose('tool-result-explanation', 3), summary('usage-3', 'call-3', 4)], null)
        const first = result.blocks[0]!
        expect(first.kind === 'agent-text' ? first.roundSummary : null).toMatchObject({
            numTurns: 3, agyUsage: { total_tokens: 660, output_tokens: 150 },
        })
        const noOutput = reduceChatBlocks([summary('orphan', 'old-call', 1),
            wire('user', { role: 'user', content: { type: 'text', text: 'New turn' } }, 2), prose('new-answer', 3)], null)
        const last = noOutput.blocks.at(-1)!
        expect(last.kind === 'agent-text' ? last.roundSummary : null).toBeUndefined()
    })

    it('sums distinct calls in one response, deduplicates replay and preserves native context', () => {
        const context = wire('context', { role: 'agent', content: { type: 'codex', data: {
            type: 'token_count', info: { total: { inputTokens: 0, outputTokens: 0 }, contextTokens: 12_000, modelContextWindow: 100_000 },
        } } }, 2)
        const result = reduceChatBlocks([
            prose('first', 1), context, summary('usage-1', 'call-1', 3),
            prose('second', 4), summary('usage-2', 'call-2', 5), summary('replay', 'call-1', 6),
        ], null)
        expect(result.blocks.map(block => block.kind)).toEqual(['agent-text', 'agent-text'])
        const first = result.blocks[0]!
        expect(first.kind === 'agent-text' ? first.roundSummary : null).toMatchObject({
            provider: 'agy', numTurns: 2, agyRequestIds: ['["native","call-1"]', '["native","call-2"]'],
            agyUsage: { input_tokens: 240, output_tokens: 100, cache_read_tokens: 80, cache_write_tokens: 20,
                thinking_tokens: 40, total_tokens: 440 },
        })
        expect(result.latestUsage).toMatchObject({ contextSize: 12_000, contextWindow: 100_000 })
    })

    it('does not carry request totals across a new user turn or change existing ACP round replacement', () => {
        const messages = [prose('first', 1), summary('usage-1', 'call-1', 2),
            wire('user', { role: 'user', content: { type: 'text', text: 'Next' } }, 3),
            prose('second', 4), summary('usage-2', 'call-2', 5)]
        const result = reduceChatBlocks(messages, null)
        const responses = result.blocks.filter(block => block.kind === 'agent-text')
        expect(responses.map(block => block.roundSummary?.agyUsage?.total_tokens)).toEqual([220, 220])
        const acp = wire('acp', { role: 'agent', content: { type: 'codex', data: { type: 'round-summary', summary: {
            provider: 'agy', agy_usage: { input_tokens: 900, output_tokens: 100 }, duration_ms: 5000,
        } } } }, 6)
        const updated = reduceChatBlocks([...messages, acp], null)
        const last = updated.blocks.at(-1)!
        expect(last.kind === 'agent-text' ? last.roundSummary : null).toMatchObject({
            agyUsage: { input_tokens: 900, output_tokens: 100 }, durationMs: 5000,
        })
        expect(last.kind === 'agent-text' ? last.roundSummary?.agyRequestIds : null).toBeUndefined()
    })
})
