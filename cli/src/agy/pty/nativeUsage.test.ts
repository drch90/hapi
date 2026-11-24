import { describe, expect, it, vi } from 'vitest'
import { readAgyNativeUsage } from './nativeUsage'
import { decodeAgyStep, type AgyNativeStep } from './transcript'

const conversationId = '91a533b7-d0ae-4466-8c1e-9dc5bcf29bac'
const createdAt = Date.parse('2026-01-01T00:00:00Z')

function step(index: number, overrides: Partial<AgyNativeStep> = {}): AgyNativeStep {
    return {
        ...decodeAgyStep({ idx: index, step_type: 15, status: 3, step_format: 0, step_payload: new Uint8Array() }),
        createdAt,
        usage: { requestId: `request-${index}`, inputTokens: 120, outputTokens: 50,
            cacheReadTokens: 40, cacheWriteTokens: 10, thinkingTokens: 20 },
        ...overrides
    }
}

function source(rows: AgyNativeStep[]) {
    return {
        maxIndex: vi.fn(async () => rows.at(-1)?.index ?? -1),
        read: vi.fn(async (from: number) => rows.filter(row => row.index >= from).slice(0, 512)),
        close: vi.fn()
    }
}

describe('read-only native Antigravity usage', () => {
    it('returns genuine request counts and times, without adding thinking or guessing a model', async () => {
        const transcript = source([step(0), step(1, { model: 'gemini-native' })])
        const page = await readAgyNativeUsage({ conversationId, fromIndex: 0, since: createdAt }, () => transcript)
        expect(page.calls).toEqual([
            { requestId: 'request-0', createdAt, model: null, inputTokens: 120, outputTokens: 50,
                cacheReadTokens: 40, cacheCreationTokens: 10 },
            { requestId: 'request-1', createdAt, model: 'gemini-native', inputTokens: 120, outputTokens: 50,
                cacheReadTokens: 40, cacheCreationTokens: 10 }
        ])
        expect(page).toMatchObject({ conversationId, nextIndex: 2, pendingIndex: null, hasMore: false, reset: false })
        expect(transcript.close).toHaveBeenCalledOnce()
    })

    it('keeps the driver fallback identity when a native request id is absent', async () => {
        const row = step(3)
        row.usage!.requestId = ''
        row.createdAt = createdAt + 0.25
        const page = await readAgyNativeUsage({ conversationId, fromIndex: 0, since: createdAt }, () => source([row]))
        expect(page.calls[0]).toMatchObject({ requestId: `step:3:${row.createdAt}`, createdAt })
    })

    it('skips pre-HAPI, missing, future, empty and unsafe usage, and revisits unfinished model calls', async () => {
        const rows = [
            step(0, { createdAt: createdAt - 1 }),
            step(1, { createdAt: undefined }),
            step(2, { createdAt: Date.now() + 60_000 }),
            step(3, { usage: undefined }),
            step(4, { type: 132, terminal: false }),
            step(5, { terminal: false }),
            step(6, { terminal: false }),
            step(7, { usage: { requestId: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
                cacheWriteTokens: 0, thinkingTokens: 0 } }),
            step(8, { usage: { ...step(0).usage!, inputTokens: Number.MAX_SAFE_INTEGER } }),
            step(9)
        ]
        const page = await readAgyNativeUsage({ conversationId, fromIndex: 0, since: createdAt }, () => source(rows))
        expect(page.calls.map(call => call.requestId)).toEqual(['request-9'])
        expect(page.pendingIndex).toBe(5)
        expect(page.nextIndex).toBe(10)
    })

    it('bounds pages and supports scanning the remaining native steps', async () => {
        const transcript = source(Array.from({ length: 514 }, (_, index) => step(index)))
        const first = await readAgyNativeUsage({ conversationId, fromIndex: 0, since: createdAt }, () => transcript)
        expect(first.calls).toHaveLength(512)
        expect(first.hasMore).toBe(true)
        const next = await readAgyNativeUsage({ conversationId, fromIndex: first.nextIndex, since: createdAt }, () => transcript)
        expect(next.calls.map(call => call.requestId)).toEqual(['request-512', 'request-513'])
        expect(next.hasMore).toBe(false)
    })

    it('restarts an out-of-range cursor after native rewind, and handles an empty store', async () => {
        const transcript = source([step(0)])
        const page = await readAgyNativeUsage({ conversationId, fromIndex: 900, since: createdAt }, () => transcript)
        expect(transcript.read).toHaveBeenCalledWith(0)
        expect(page).toMatchObject({ reset: true, nextIndex: 1 })
        const empty = await readAgyNativeUsage({ conversationId, fromIndex: 0, since: createdAt }, () => source([]))
        expect(empty).toMatchObject({ calls: [], reset: false, nextIndex: 0, hasMore: false })
    })

    it('closes the reader on errors and rejects unsafe paths before opening a store', async () => {
        const transcript = source([])
        transcript.read.mockRejectedValue(new Error('Malformed native data'))
        await expect(readAgyNativeUsage({ conversationId, fromIndex: 0, since: createdAt }, () => transcript))
            .rejects.toThrow('Malformed native data')
        expect(transcript.close).toHaveBeenCalledOnce()
        const create = vi.fn(() => transcript)
        await expect(readAgyNativeUsage({ conversationId: '../../secrets', fromIndex: 0, since: 0 }, create)).rejects.toThrow()
        expect(create).not.toHaveBeenCalled()
    })
})
