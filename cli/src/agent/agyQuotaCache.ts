import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { AgentQuotaBucketSchema, type AgentQuotaBucket } from '@hapi/protocol/apiTypes'
import { resolveHapiHomeDir } from '@/configuration'

const FRESH_MS = 60_000
const snapshotSchema = z.object({
    updatedAt: z.number().nonnegative(),
    buckets: z.array(AgentQuotaBucketSchema).min(1),
})
type NativeQuota = { id: string; remainingFraction: number; resetTime: string | null }

/** Match the file-backed OAuth identity used by our native/headless launches.
 * Only the digest leaves this function. A token change invalidates the cache;
 * missing/custom credential storage falls back to the bounded CLI probe. */
export function getAgyQuotaCacheIdentity(env: NodeJS.ProcessEnv = process.env): string | null {
    if (env.VITEST === 'true' && !env.HAPI_HOME) return null
    const userDirectory = env.HOME || env.USERPROFILE || homedir()
    try {
        const credential = readFileSync(join(userDirectory, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
        return createHash('sha256').update(credential).update(JSON.stringify([
            resolveHapiHomeDir(env), userDirectory, env.GEMINI_CLI_HOME, env.GOOGLE_APPLICATION_CREDENTIALS,
            env.GEMINI_API_KEY, env.GOOGLE_API_KEY,
        ])).digest('hex')
    } catch { return null }
}

function snapshotPath(env: NodeJS.ProcessEnv): string | null {
    const identity = getAgyQuotaCacheIdentity(env)
    return identity ? join(resolveHapiHomeDir(env), 'agent-quotas-live', `agy-quota-${identity}.json`) : null
}

export function readAgyQuotaSnapshot(env: NodeJS.ProcessEnv = process.env): z.infer<typeof snapshotSchema> | null {
    const path = snapshotPath(env)
    if (!path) return null
    try {
        const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
        const now = Date.now()
        if (snapshot.updatedAt > now + 1_000 || now - snapshot.updatedAt >= FRESH_MS
            || snapshot.buckets.some(bucket => bucket.resetsAt != null && bucket.resetsAt <= now)) return null
        return snapshot
    } catch { return null }
}

/** Bind identity when the native process starts, so an old session cannot
 * publish its quotas under credentials selected later by another process. */
export function createAgyQuotaRecorder(env: NodeJS.ProcessEnv = process.env): (quotas: readonly NativeQuota[], observedAt: number) => void {
    const path = snapshotPath(env)
    let previous = ''
    let lastUpdatedAt = 0
    return (quotas, observedAt) => {
        if (!path || !Number.isFinite(observedAt) || observedAt <= lastUpdatedAt
            || observedAt > Date.now() + 1_000 || Date.now() - observedAt >= FRESH_MS) return
        const buckets: AgentQuotaBucket[] = quotas.flatMap(quota => {
            const match = /^(gemini|3p)-(5h|weekly)$/.exec(quota.id)
            if (!match || !Number.isFinite(quota.remainingFraction) || quota.remainingFraction < 0 || quota.remainingFraction > 1) return []
            const group = match[1] === 'gemini' ? 'Gemini Models' : 'Claude and GPT models'
            const window = match[2]!
            const remainingPercent = Math.round(quota.remainingFraction * 1000) / 10
            const resetsAt = quota.resetTime ? Date.parse(quota.resetTime) : null
            if (resetsAt !== null && (!Number.isFinite(resetsAt) || resetsAt <= Date.now())) return []
            return [{ id: quota.id, group, window, label: `${group} · ${window === 'weekly' ? 'Weekly' : '5h'}`,
                remainingPercent, usedPercent: Math.round((100 - remainingPercent) * 10) / 10, resetsAt }]
        })
        if (buckets.length === 0) return
        const signature = JSON.stringify(buckets)
        if (signature === previous && observedAt - lastUpdatedAt < FRESH_MS / 2) return
        const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
        try {
            try {
                const existing = snapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
                if (existing.updatedAt > observedAt) return
            } catch { /* A missing or invalid observation can be replaced. */ }
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
            writeFileSync(tmp, JSON.stringify({ updatedAt: observedAt, buckets }), { mode: 0o600 })
            renameSync(tmp, path)
            previous = signature
            lastUpdatedAt = observedAt
        } catch {
            // Quota enrichment must never interrupt the native conversation.
        } finally {
            try { rmSync(tmp, { force: true }) } catch { /* Best effort. */ }
        }
    }
}
