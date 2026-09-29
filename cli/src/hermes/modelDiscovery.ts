import type { HermesModelsResponse } from '@hapi/protocol'
import { AcpStdioTransport } from '@/agent/backends/acp/AcpStdioTransport'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import { parseHermesModelsResponse } from './models'
import packageJson from '../../package.json'

const cache = new Map<string, { expires: number; result: HermesModelsResponse }>()
const inflight = new Map<string, Promise<HermesModelsResponse>>()

async function probe(cwd: string): Promise<HermesModelsResponse> {
    const transport = await AcpStdioTransport.create({ command: getAgentLaunchCommand('hermes'), args: ['acp'] })
    try {
        await transport.sendRequest('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'hapi-hermes-models', version: packageJson.version }
        }, { timeoutMs: 25_000 })
        return parseHermesModelsResponse(await transport.sendRequest('session/new', { cwd, mcpServers: [] }, { timeoutMs: 35_000 }))
    } finally {
        await transport.close().catch(() => {})
    }
}

export async function listHermesModelsForCwd(cwd: string, refresh = false): Promise<HermesModelsResponse> {
    if (!cwd.trim()) return { success: false, error: 'cwd is required' }
    const key = JSON.stringify([cwd, getAgentLaunchCommand('hermes'), process.env.HERMES_HOME ?? ''])
    const pending = inflight.get(key)
    if (pending) return pending
    const cached = cache.get(key)
    if (!refresh && cached && cached.expires > Date.now()) return cached.result
    const request = probe(cwd).then(result => {
        if (result.success) {
            cache.set(key, { result, expires: Date.now() + 60_000 })
            // The runner can visit arbitrarily many workspaces over its lifetime.
            if (cache.size > 32) cache.delete(cache.keys().next().value!)
        }
        return result
    }).catch((error: unknown): HermesModelsResponse => ({ success: false, error: error instanceof Error ? error.message : 'Hermes model discovery failed' }))
        .finally(() => inflight.delete(key))
    inflight.set(key, request)
    return request
}
