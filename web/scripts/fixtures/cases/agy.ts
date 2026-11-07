import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * agy (Antigravity) prose and historical tools arrive through the
 * Claude-style output envelope (content.type === 'output') with
 * data.type === 'agy_message' (planner prose) and 'agy_tool_action' (a DONE
 * tool action whose content is its result). See normalizeAgent.ts (agy
 * branches) and cli/src/api/apiSession.ts sendAgySessionMessage. Current native
 * sessions combine that prose with common codex-family tool lifecycle records.
 */
export const agyCases: FixtureCase[] = [
    ...([
        { name: 'positive', contexts: [10_034], description: 'Native Antigravity context snapshots carry positive occupancy and the native window with zero billable tokens, without adding chat rows.' },
        { name: 'compacted', contexts: [10_034, 1_000], description: 'Native Antigravity context occupancy decreases after compaction; the latest snapshot replaces the previous size.' },
        { name: 'cleared', contexts: [10_034, 1_000, 0], description: 'Native Antigravity explicitly reports an empty context; zero clears the previous occupancy while preserving the native window.' },
    ] as const).map(({ name, contexts, description }): FixtureCase => ({
        name: `agy-native-context-${name}`,
        description,
        messages: [
            wireMessage({ id: 'agy-context-prose', seq: 1, createdAt: T0, content: { role: 'agent',
                content: { type: 'output', data: { type: 'agy_message', id: 'agy-context-answer', content: 'The answer is ready.', model: 'Gemini 3.8 Flash (High)' } } } }),
            ...contexts.map((contextTokens, index) => wireMessage({ id: `agy-context-${index}`, seq: index + 2, createdAt: T0 + index + 1,
                content: { role: 'agent', content: { type: 'codex', data: {
                    type: 'token_count', model: 'Gemini 3.8 Flash (High)',
                    usageSchema: 'hapi.usage.v1', inputTokenSemantics: 'includes-cache',
                    info: { total: { inputTokens: 0, outputTokens: 0 }, contextTokens, modelContextWindow: 1_048_576 },
                } } } })),
        ],
    })),
    {
        name: 'agy-native-permission-reply-id',
        description: 'Native Antigravity uses a one-time approval reply ID linked to the real tool call, including after a previous reply was canceled.',
        messages: [wireMessage({ id: 'agy-native-tool', seq: 1, createdAt: T0, content: { role: 'agent', content: { type: 'codex', data: {
            type: 'tool-call', callId: 'native-call-1', name: 'Bash', input: { command: 'python3 script.py' }, status: 'pending',
        } } } })],
        agentState: {
            requests: { 'agy-permission-new': { tool: 'Bash', toolCallId: 'native-call-1', arguments: { command: 'python3 script.py' }, createdAt: T0 + 2 } },
            completedRequests: { 'agy-permission-old': { tool: 'Bash', toolCallId: 'native-call-1', arguments: { command: 'python3 script.py' },
                createdAt: T0, completedAt: T0 + 1, status: 'canceled', decision: 'abort' } },
        },
    },
    {
        name: 'agy-native-streamed-prose',
        description: 'Native Antigravity prose snapshots replace the same text stream and preserve the response model; thinking settles separately.',
        messages: [
            wireMessage({ id: 'agy-thinking-live', seq: 1, createdAt: T0, content: { role: 'agent',
                content: { type: 'codex', data: { type: 'reasoning', id: 'agy-think-1', message: 'Consider the plan', live: true } } } }),
            wireMessage({ id: 'agy-text-live-1', seq: 2, createdAt: T0 + 1, content: { role: 'agent',
                content: { type: 'output', data: { type: 'agy_message', id: 'agy-text-1', content: 'First', model: 'Gemini 3.8 Flash (High)' } } } }),
            wireMessage({ id: 'agy-text-live-2', seq: 3, createdAt: T0 + 2, content: { role: 'agent',
                content: { type: 'output', data: { type: 'agy_message', id: 'agy-text-1', content: 'First, prepare the plan.', model: 'Gemini 3.8 Flash (High)' } } } }),
            wireMessage({ id: 'agy-thinking-final', seq: 4, createdAt: T0 + 3, content: { role: 'agent',
                content: { type: 'codex', data: { type: 'reasoning', id: 'agy-think-1', message: 'Consider the plan and request review.' } } } }),
            wireMessage({ id: 'agy-text-final', seq: 5, createdAt: T0 + 4, content: { role: 'agent',
                content: { type: 'output', data: { type: 'agy_message', id: 'agy-text-1', content: 'First, prepare the plan. Second, request review.', model: 'Gemini 3.8 Flash (High)' } } } }),
        ],
    },
    ...(['pending', 'approved', 'denied'] as const).map((status): FixtureCase => {
        const input = { CommandLine: 'python3 script.py', Cwd: '/repo', command: 'python3 script.py', cwd: '/repo' }
        const request = { tool: 'Bash', arguments: input, createdAt: T0 }
        return {
            name: `agy-acp-permission-${status}`,
            description: `Antigravity ACP ${status} approval attaches to its canonical tool card with the exact native call id.`,
            messages: [wireMessage({ id: 'agy-approval-tool', seq: 1, createdAt: T0, content: {
                role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'agy-approval-call',
                    name: 'Bash', input, status: 'pending' } },
            } })],
            agentState: status === 'pending'
                ? { requests: { 'agy-approval-call': request } }
                : { requests: {}, completedRequests: { 'agy-approval-call': {
                    ...request, status, decision: status, completedAt: T0 + 1000,
                } } },
        }
    }),
    {
        name: 'agy-acp-tools-and-prose',
        description: 'Antigravity ACP combines canonical tool lifecycle records with model-attributed agy prose after a steered turn.',
        messages: [
            wireMessage({ id: 'agy-acp-tool', seq: 1, createdAt: T0, content: {
                role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'agy-acp-call',
                    name: 'Bash', input: { command: 'git status' }, status: 'in_progress' } },
            } }),
            wireMessage({ id: 'agy-acp-result', seq: 2, createdAt: T0 + 1, content: {
                role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'agy-acp-call',
                    output: 'Working tree clean.', is_error: false } },
            } }),
            wireMessage({ id: 'agy-acp-prose', seq: 3, createdAt: T0 + 2, content: {
                role: 'agent', content: { type: 'output', data: { type: 'agy_message',
                    content: 'I applied your updated instructions.', model: 'Gemini 3.8 Flash (High)' } },
            } }),
        ],
    },
    {
        name: 'agy-message',
        description: 'agy flavor: agy_message planner prose becomes a plain agent-text block (per-turn data.model is footer metadata outside the normative projection; meta.sentFrom cli is carried on the wire but dropped).',
        messages: [
            wireMessage({
                id: 'msg-agy-721',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'agy_message',
                            content: 'Looking at the failing build, the Gradle wrapper version is stale. I will bump it and rerun.',
                            model: 'Gemini 3 Pro (High)'
                        }
                    },
                    meta: { sentFrom: 'cli' }
                }
            })
        ]
    },
    {
        name: 'agy-tool-action-run-command',
        description: 'agy flavor: agy_tool_action RUN_COMMAND with a paired run_command invocation maps to a canonical Bash tool-call (input.CommandLine/Cwd translated to command/cwd, bookkeeping args dropped) already COMPLETED (paired tool-result), keyed by data.toolUseId with the Created At/Completed At preamble stripped from the result.',
        messages: [
            wireMessage({
                id: 'msg-agy-731',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'agy_tool_action',
                            name: 'RUN_COMMAND',
                            toolName: 'run_command',
                            toolUseId: 'conv-7c1b:12',
                            input: {
                                CommandLine: './gradlew --version',
                                Cwd: '/repo/android',
                                toolSummary: 'Check Gradle version',
                                WaitMsBeforeAsync: 5000,
                                Blocking: true
                            },
                            content: 'Created At: 2025-08-12T11:20:04Z\nCompleted At: 2025-08-12T11:20:06Z\nThe command completed successfully.\nOutput:\nGradle 8.7'
                        }
                    },
                    meta: { sentFrom: 'cli' }
                }
            })
        ]
    }
]
