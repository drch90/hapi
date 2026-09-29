import { describe, expect, it } from 'bun:test'
import { AgentFlavorSchema, CREATABLE_AGENT_FLAVORS, getPermissionModesForFlavor, isPermissionModeAllowedForFlavor } from './modes'
import { MetadataSchema } from './schemas'
import { getFlavorLabel } from './flavors'
import { toSessionSummaryMetadata } from './sessionSummary'

describe('Hermes protocol', () => {
    it('is launchable with its own permissions and native resume identity', () => {
        expect(AgentFlavorSchema.parse('hermes')).toBe('hermes')
        expect(CREATABLE_AGENT_FLAVORS).toContain('hermes')
        expect(getFlavorLabel('hermes')).toBe('Hermes')
        expect(getPermissionModesForFlavor('hermes')).toEqual(['default', 'acceptEdits'])
        expect(isPermissionModeAllowedForFlavor('yolo', 'hermes')).toBe(false)
        const metadata = MetadataSchema.parse({ path: '/tmp', host: 'host', flavor: 'hermes', hermesSessionId: 'native', claudeSessionId: 'unrelated' })
        expect(toSessionSummaryMetadata(metadata)?.agentSessionId).toBe('native')
        expect(toSessionSummaryMetadata({ ...metadata, hermesSessionId: undefined })?.agentSessionId).toBeUndefined()
    })
})
