import { AcpSdkBackend } from '@/agent/backends/acp'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'

export function createHermesBackend(onClose: (error: Error) => void): AcpSdkBackend {
    return new AcpSdkBackend({
        command: getAgentLaunchCommand('hermes'),
        args: ['acp'],
        env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        flavor: 'hermes',
        onClose
    })
}
