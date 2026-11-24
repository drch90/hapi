import { AgyNativeUsageRequestSchema, type AgyNativeUsagePage, type AgyNativeUsageRequest } from '@hapi/protocol/apiTypes'
import { AgyTranscript, type AgyTranscriptSource } from './transcript'

/** This observer never submits input, attaches to the agent, or changes its native store. */
export async function readAgyNativeUsage(
    input: AgyNativeUsageRequest,
    createTranscript: (id: string) => AgyTranscriptSource = id => new AgyTranscript(id)
): Promise<AgyNativeUsagePage> {
    const request = AgyNativeUsageRequestSchema.parse(input)
    const transcript = createTranscript(request.conversationId)
    try {
        const lastIndex = await transcript.maxIndex()
        const reset = request.fromIndex > lastIndex + 1
        const fromIndex = reset ? 0 : request.fromIndex
        const steps = await transcript.read(fromIndex)
        let pendingIndex: number | null = null
        const calls: AgyNativeUsagePage['calls'] = []
        for (const step of steps) {
            if (step.type !== 15) continue
            if (!step.terminal) {
                pendingIndex = Math.min(pendingIndex ?? step.index, step.index)
                continue
            }
            const usage = step.usage
            const createdAt = step.createdAt === undefined ? NaN : Math.floor(step.createdAt)
            if (!usage || !Number.isSafeInteger(createdAt) || createdAt < request.since || createdAt > Date.now() + 1_000) continue
            const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
            if (!Number.isSafeInteger(total) || total <= 0) continue
            calls.push({
                requestId: usage.requestId.trim() || `step:${step.index}:${step.createdAt ?? ''}`,
                createdAt,
                // Never attribute historical calls to the session's current model.
                model: step.model.trim() || null,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheCreationTokens: usage.cacheWriteTokens
            })
        }
        return {
            conversationId: request.conversationId,
            nextIndex: steps.length ? steps[steps.length - 1]!.index + 1 : fromIndex,
            pendingIndex,
            hasMore: steps.length === 512,
            reset,
            calls
        }
    } finally {
        transcript.close()
    }
}
