import { getBuiltinSlashCommands } from '@hapi/protocol/slashCommands'
import type { SlashCommand } from '@hapi/protocol'
import type { AcpCommandDescriptor } from '@/agent/backends/acp/AcpSdkBackend'

export function parseHermesCommand(text: string): { name: string; args: string } | null {
    const match = text.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    return match ? { name: match[1].toLowerCase(), args: match[2]?.trim() ?? '' } : null
}

export function hermesCommands(native?: readonly AcpCommandDescriptor[]): SlashCommand[] {
    return getBuiltinSlashCommands('hermes').filter(command => !native || command.name === 'help' || native.some(row => row.name === command.name))
        .map(command => {
            const row = native?.find(row => row.name === command.name)
            // HAPI's context/history and model semantics are explicit in its own descriptions.
            return row?.inputHint && !['model', 'reset'].includes(command.name)
                ? { ...command, description: `${command.description} (${row.inputHint})` }
                : command
        })
}

export function isHermesMutation(name: string): boolean {
    return ['model', 'reset', 'compress'].includes(name)
}
