import chalk from 'chalk'
import { HERMES_PERMISSION_MODES } from '@hapi/protocol'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'
import type { CommandDefinition } from './types'

export function parseHermesCommandOptions(args: string[]) {
    const flags = new Set(['--started-by', '--hapi-starting-mode', '--existing-session-id', '--resume', '--model', '--permission-mode'])
    for (let i = 0; i < args.length; i += 2) {
        if (!flags.has(args[i])) throw new Error(`Unsupported Hermes option: ${args[i]}`)
        if (!args[i + 1]?.trim() || args[i + 1].startsWith('-')) throw new Error(`Missing ${args[i]} value`)
    }
    const options = parseRemoteAgentCommandOptions(args, HERMES_PERMISSION_MODES, ['remote'])
    if (options.startedBy && !['terminal', 'runner'].includes(options.startedBy)) throw new Error('Invalid --started-by value')
    if (options.resumeSessionId && !options.existingSessionId) throw new Error('Use hapi resume <hapi-session-id> to resume a Hermes session')
    return { ...options, startingMode: 'remote' as const }
}

export const hermesCommand: CommandDefinition = {
    name: 'hermes', requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseHermesCommandOptions(commandArgs)
            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()
            const { runHermes } = await import('@/hermes/runHermes')
            await runHermes(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
            process.exit(1)
        }
    }
}
