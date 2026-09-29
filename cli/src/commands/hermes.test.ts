import { describe, expect, it } from 'vitest'
import { parseHermesCommandOptions } from './hermes'

describe('Hermes command', () => {
    it('uses remote mode and accepts model and native edit policy', () => {
        expect(parseHermesCommandOptions(['--model', 'provider:model', '--permission-mode', 'acceptEdits'])).toMatchObject({ startingMode: 'remote', model: 'provider:model', permissionMode: 'acceptEdits' })
    })
    it.each([['--yolo'], ['--hapi-starting-mode', 'local'], ['--model'], ['--model', '--yolo'], ['--permission-mode', 'dont_ask'], ['--resume', 'external-id']])('rejects unsupported or malformed options %j', (...args) => {
        expect(() => parseHermesCommandOptions(args)).toThrow()
    })
    it('accepts runner resume bound to an existing HAPI row', () => {
        expect(parseHermesCommandOptions(['--resume', 'native-id', '--existing-session-id', 'hapi-id', '--started-by', 'runner'])).toMatchObject({ existingSessionId: 'hapi-id', resumeSessionId: 'native-id' })
    })
})
