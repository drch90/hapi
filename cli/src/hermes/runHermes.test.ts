import { beforeEach, describe, expect, it, vi } from 'vitest'

const bootstrap = vi.hoisted(() => ({
    fresh: vi.fn(),
    existing: vi.fn(),
    stopped: new Error('bootstrap boundary'),
}))

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: bootstrap.fresh,
    bootstrapExistingSession: bootstrap.existing,
}))

import { parseHermesCommandOptions } from '@/commands/hermes'
import { runHermes } from './runHermes'

describe('Hermes runner session identity', () => {
    beforeEach(() => {
        bootstrap.fresh.mockReset().mockRejectedValue(bootstrap.stopped)
        bootstrap.existing.mockReset().mockRejectedValue(bootstrap.stopped)
    })

    it('adopts the hub reservation when starting a fresh session', async () => {
        const options = parseHermesCommandOptions(['--hapi-session-id', 'reserved-id', '--started-by', 'runner'])
        await expect(runHermes({ ...options, workingDirectory: '/work/hermes' })).rejects.toBe(bootstrap.stopped)
        expect(bootstrap.fresh).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            flavor: 'hermes', reservedSessionId: 'reserved-id', workingDirectory: '/work/hermes', reportStarted: false,
        }))
        expect(bootstrap.existing).not.toHaveBeenCalled()
    })

    it('reopens the existing hub row when resuming a native session', async () => {
        const options = parseHermesCommandOptions(['--existing-session-id', 'existing-id', '--resume', 'native-id'])
        await expect(runHermes({ ...options, workingDirectory: '/work/hermes' })).rejects.toBe(bootstrap.stopped)
        expect(bootstrap.existing).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            flavor: 'hermes', sessionId: 'existing-id', workingDirectory: '/work/hermes', reportStarted: false,
        }))
        expect(bootstrap.fresh).not.toHaveBeenCalled()
    })
})
