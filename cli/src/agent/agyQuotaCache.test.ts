import { EventEmitter } from 'node:events'
import * as childProcess from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as agentAvailability from './agentAvailability'
import * as processUtils from '@/utils/process'
import { createAgyQuotaRecorder, readAgyQuotaSnapshot } from './agyQuotaCache'
import { _resetAgentQuotasCacheForTests, getAgentQuotasResponse, probeAgyQuota } from './agentQuotas'

vi.mock('node:child_process', async importOriginal => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    spawn: vi.fn(() => { throw new Error('Unexpected headless quota probe') }),
}))

const directories: string[] = []
afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.mocked(childProcess.spawn).mockClear()
    _resetAgentQuotasCacheForTests()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function environment() {
    const directory = mkdtempSync(join(tmpdir(), 'hapi-agy-quota-'))
    directories.push(directory)
    const credentialDirectory = join(directory, '.gemini', 'antigravity-cli')
    mkdirSync(credentialDirectory, { recursive: true })
    const credential = join(credentialDirectory, 'antigravity-oauth-token')
    writeFileSync(credential, 'fixture-account-a')
    return { env: { HOME: directory, HAPI_HOME: join(directory, 'hapi'), VITEST: 'true' }, credential }
}

const quotas = () => [
    { id: 'gemini-5h', remainingFraction: 0.75, resetTime: new Date(Date.now() + 3_600_000).toISOString() },
    { id: '3p-weekly', remainingFraction: 0.25, resetTime: null },
]

describe('native Antigravity quota cache', () => {
    it('shares fresh observations with the runner and invalidates its response without querying /usage', async () => {
        const { env } = environment()
        vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation(agent => ({ agent, available: agent === 'agy' }))
        const spawn = vi.spyOn(childProcess, 'spawn')
        const record = createAgyQuotaRecorder(env)
        let now = Date.now()
        vi.spyOn(Date, 'now').mockImplementation(() => now)
        record(quotas(), now)
        const first = await getAgentQuotasResponse({ env })
        expect(first.accounts.find(account => account.agent === 'agy')).toMatchObject({ status: 'ok', buckets: [
            { id: 'gemini-5h', group: 'Gemini Models', window: '5h', usedPercent: 25, remainingPercent: 75 },
            { id: '3p-weekly', group: 'Claude and GPT models', window: 'weekly', usedPercent: 75, remainingPercent: 25 },
        ] })
        now += 1_000
        record([{ ...quotas()[0]!, remainingFraction: 0.5 }], now)
        const second = await getAgentQuotasResponse({ env })
        expect(second.accounts.find(account => account.agent === 'agy')?.buckets[0]?.usedPercent).toBe(50)
        expect(spawn.mock.calls.every(([, args]) => (args as string[])[1] === '/credits')).toBe(true)
        const files = readdirSync(join(env.HAPI_HOME, 'agent-quotas-live'))
        expect(files).toHaveLength(1)
        expect(readFileSync(join(env.HAPI_HOME, 'agent-quotas-live', files[0]!), 'utf8')).not.toContain('fixture-account-a')
    })

    it('expires stale hooks instead of refreshing their timestamp when polled', () => {
        const { env } = environment()
        vi.useFakeTimers()
        const observedAt = Date.now()
        const record = createAgyQuotaRecorder(env)
        const initial = quotas()
        record(initial, observedAt)
        expect(readAgyQuotaSnapshot(env)).not.toBeNull()
        vi.advanceTimersByTime(60_001)
        record(initial, observedAt)
        expect(readAgyQuotaSnapshot(env)).toBeNull()
        record(initial, Date.now())
        expect(readAgyQuotaSnapshot(env)).not.toBeNull()
    })

    it('does not replace a newer account observation with a late update from another native process', () => {
        const { env } = environment()
        const olderProcess = createAgyQuotaRecorder(env)
        const newerProcess = createAgyQuotaRecorder(env)
        const now = Date.now()
        newerProcess([{ ...quotas()[0]!, remainingFraction: 0.4 }], now - 1000)
        olderProcess([{ ...quotas()[0]!, remainingFraction: 0.9 }], now - 2000)
        expect(readAgyQuotaSnapshot(env)?.buckets[0]?.remainingPercent).toBe(40)
    })

    it('invalidates the combined runner cache on account changes even with identical observation timestamps', async () => {
        const { env, credential } = environment()
        vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation(agent => ({ agent, available: agent === 'agy' }))
        vi.spyOn(Date, 'now').mockReturnValue(Date.now())
        createAgyQuotaRecorder(env)(quotas(), Date.now())
        expect((await getAgentQuotasResponse({ env })).accounts[1]?.buckets[0]?.remainingPercent).toBe(75)
        writeFileSync(credential, 'fixture-account-b')
        createAgyQuotaRecorder(env)([{ ...quotas()[0]!, remainingFraction: 0.1 }], Date.now())
        expect((await getAgentQuotasResponse({ env })).accounts[1]?.buckets[0]?.remainingPercent).toBe(10)
    })

    it('isolates a switched account from an existing native session and other HAPI homes', () => {
        const { env, credential } = environment()
        const recordOldAccount = createAgyQuotaRecorder(env)
        recordOldAccount(quotas(), Date.now())
        expect(readAgyQuotaSnapshot({ ...env, HAPI_HOME: `${env.HAPI_HOME}-other` })).toBeNull()
        writeFileSync(credential, 'fixture-account-b')
        recordOldAccount([{ ...quotas()[0]!, remainingFraction: 0.1 }], Date.now() + 1)
        expect(readAgyQuotaSnapshot(env)).toBeNull()
        createAgyQuotaRecorder(env)(quotas(), Date.now())
        expect(readAgyQuotaSnapshot(env)?.buckets[0]?.remainingPercent).toBe(75)
    })

    it('rejects expired windows, malformed snapshots, unsafe fractions and missing credentials', () => {
        const { env, credential } = environment()
        const record = createAgyQuotaRecorder(env)
        const now = Date.now()
        record([{ id: 'gemini-5h', remainingFraction: -1, resetTime: null }], now)
        expect(readAgyQuotaSnapshot(env)).toBeNull()
        record([{ id: 'gemini-5h', remainingFraction: 0.5, resetTime: new Date(now - 1).toISOString() }], now)
        expect(readAgyQuotaSnapshot(env)).toBeNull()
        record(quotas(), now)
        const directory = join(env.HAPI_HOME, 'agent-quotas-live')
        writeFileSync(join(directory, readdirSync(directory)[0]!), '{broken')
        expect(readAgyQuotaSnapshot(env)).toBeNull()
        rmSync(credential)
        expect(readAgyQuotaSnapshot(env)).toBeNull()
        expect(() => createAgyQuotaRecorder(env)(quotas(), now)).not.toThrow()
    })
})

describe('bounded Antigravity quota probes', () => {
    function probeHarness(nativeQuota = false) {
        const { env, credential } = environment()
        if (nativeQuota) createAgyQuotaRecorder(env)(quotas(), Date.now())
        else rmSync(credential) // Exercise the independent headless fallback.
        vi.useFakeTimers()
        vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation(agent => ({ agent, available: agent === 'agy' }))
        const children: Array<{ child: EventEmitter; stdout: EventEmitter; command: string }> = []
        vi.spyOn(childProcess, 'spawn').mockImplementation((_command, args) => {
            const stdout = new EventEmitter()
            const child = Object.assign(new EventEmitter(), { stdout, stderr: new EventEmitter() })
            children.push({ child, stdout, command: (args as string[])[1]! })
            return child as childProcess.ChildProcess
        })
        const kill = vi.spyOn(processUtils, 'killProcessByChildProcess').mockResolvedValue(true)
        return { env, children, kill }
    }

    it('preserves G1 credits when the subscription quota comes from a native snapshot', async () => {
        const h = probeHarness(true)
        const pending = probeAgyQuota(h.env)
        expect(h.children.map(child => child.command)).toEqual(['/credits'])
        h.children[0]!.stdout.emit('data', JSON.stringify({ command: { name: 'credits', data: { remaining_credits: 1500 } } }))
        h.children[0]!.child.emit('close', 0)
        expect(await pending).toMatchObject({ status: 'ok', creditsLabel: '1,500 G1 credits', buckets: [{ remainingPercent: 75 }, { remainingPercent: 25 }] })
    })

    it('allows a successful cold start beyond five seconds and coalesces concurrent refreshes', async () => {
        const h = probeHarness()
        const first = getAgentQuotasResponse({ env: h.env, refresh: true })
        const second = getAgentQuotasResponse({ env: h.env, refresh: true })
        expect(h.children).toHaveLength(2)
        await vi.advanceTimersByTimeAsync(7_330)
        expect(h.kill).not.toHaveBeenCalled()
        for (const { child, stdout, command } of h.children) {
            if (command === '/usage') stdout.emit('data', JSON.stringify({ command: { name: 'usage', data: { groups: [
                { name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.75 }] },
            ] } } }))
            child.emit('close', 0)
        }
        const result = await first
        expect(result.accounts.find(account => account.agent === 'agy')).toMatchObject({ status: 'ok', buckets: [{ remainingPercent: 75 }] })
        expect(await second).toBe(result)
        expect(h.kill).not.toHaveBeenCalled()
    })

    it('kills only its own stalled probes within the hub RPC deadline', async () => {
        const h = probeHarness()
        const pending = probeAgyQuota(h.env)
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await pending).toMatchObject({ status: 'error', note: 'Antigravity /usage timed out' })
        expect(h.kill).toHaveBeenCalledTimes(2)
        for (const { child } of h.children) expect(h.kill).toHaveBeenCalledWith(child, true)
    })
})
