import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

const user = wireMessage({ id: 'hermes-user', seq: 1, createdAt: T0, content: { role: 'user', content: { type: 'text', text: 'Create a project file.' } } })
const input = { tool: 'write_file', arguments: { path: '/workspace/result.txt', content: 'Hello' } }
const request = { tool: 'Approve edit: /workspace/result.txt', arguments: input, createdAt: T0 + 1_000 }

export const hermesCases: FixtureCase[] = [
    {
        name: 'hermes-model-and-steer-commands',
        description: 'Hermes provider-qualified model commands and native steer acknowledgement retain ordinary HAPI conversation history.',
        agentState: { steeringActive: true },
        messages: [
            wireMessage({ id: 'hermes-model-command', seq: 1, createdAt: T0, content: { role: 'user', content: { type: 'text', text: '/model custom:office:qwen:32b' } } }),
            wireMessage({ id: 'hermes-model-reply', seq: 2, createdAt: T0 + 1000, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Current model: custom:office:qwen:32b' } } } }),
            wireMessage({ id: 'hermes-steer-command', seq: 3, createdAt: T0 + 2000, content: { role: 'user', content: { type: 'text', text: '/steer Keep the current API unchanged.' } } }),
            wireMessage({ id: 'hermes-steer-reply', seq: 4, createdAt: T0 + 3000, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Guidance sent to the active turn.' } } } }),
        ]
    },
    {
        name: 'hermes-edit-approval-pending',
        description: 'Hermes ACP edit approvals use the existing pending-request projection with native tool arguments.',
        messages: [user],
        agentState: { requests: { 'edit-approval-1': request } }
    },
    {
        name: 'hermes-tool-and-assistant',
        description: 'Hermes ACP tool execution and assistant output use the shared generic agent envelope.',
        messages: [user, ...[
            { type: 'tool-call', name: 'write_file', callId: 'hermes-write-1', input: input.arguments },
            { type: 'tool-call-result', callId: 'hermes-write-1', output: 'File written' },
            { type: 'message', message: 'Created result.txt.' }
        ].map((data, i) => wireMessage({ id: `hermes-output-${i}`, seq: i + 2, createdAt: T0 + (i + 2) * 1000, content: { role: 'agent', content: { type: 'codex', data } } }))]
    }
]
