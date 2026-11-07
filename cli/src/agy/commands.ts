import { AGY_EFFORT_LEVELS, AGY_PERMISSION_MODES, getAgyModelChoices, type AgyModelSummary } from '@hapi/protocol';
import { getBuiltinSlashCommands } from '@hapi/protocol/slashCommands';
import type { AgyMode } from './types';
import type { AgyNativeStatus } from './pty/nativeStatus';
import { normalizeAgyInput } from './pty/delivery';

export type AgyQuery = 'help' | 'usage' | 'context' | 'status' | 'model' | 'effort' | 'permissions';
export type AgyCommand =
    | { kind: 'query'; name: AgyQuery }
    | { kind: 'compact' }
    | { kind: 'clear' }
    | { kind: 'config'; updates: Partial<AgyMode>; prompt?: string }
    | { kind: 'error'; message: string };

/** Commands occupy their own queue item; they must never become model input. */
export function resolveAgyCommand(text: string): AgyCommand | null {
    const match = /^\s*\/([a-z][a-z0-9:_-]*)(?:\s+([\s\S]*))?\s*$/i.exec(text);
    if (!match) return null;
    try { normalizeAgyInput(text); } catch (error) { return { kind: 'error', message: String(error) }; }
    const name = match[1]!.toLowerCase() === 'quota' ? 'usage' : match[1]!.toLowerCase();
    const args = match[2]?.trim() ?? '';
    const error = (usage: string): AgyCommand => ({ kind: 'error', message: `Usage: ${usage}` });
    if (name === 'plan') {
        if (['off', 'default', 'exit'].includes(args.toLowerCase())) return { kind: 'config', updates: { permissionMode: 'request-review' } };
        // A task such as `/plan /clear` is text to plan, never a second
        // control command for either HAPI or the native terminal to execute.
        const prompt = args.startsWith('/') ? `Plan the following task:\n\n${args}` : args;
        return { kind: 'config', updates: { permissionMode: 'plan' }, ...(prompt ? { prompt } : {}) };
    }
    if (name === 'default' || name === 'auto') {
        return args ? error(`/${name}`) : { kind: 'config', updates: { permissionMode: name === 'auto' ? 'auto' : 'request-review' } };
    }
    if (name === 'model') {
        if (!args) return { kind: 'query', name };
        if (/\s/.test(args)) return error('/model <model ID|default>');
        return { kind: 'config', updates: { model: args === 'default' ? null : args } };
    }
    if (name === 'effort') {
        if (!args) return { kind: 'query', name };
        if (args !== 'default' && !(AGY_EFFORT_LEVELS as readonly string[]).includes(args)) return error(`/effort <${AGY_EFFORT_LEVELS.join('|')}|default>`);
        return { kind: 'config', updates: { effort: args === 'default' ? null : args } };
    }
    if (name === 'permissions' || name === 'permission') {
        if (!args) return { kind: 'query', name: 'permissions' };
        const permissionMode = args === 'default' ? 'request-review' : args;
        if (!(AGY_PERMISSION_MODES as readonly string[]).includes(permissionMode)) return error(`/permissions <${AGY_PERMISSION_MODES.join('|')}>`);
        return { kind: 'config', updates: { permissionMode: permissionMode as AgyMode['permissionMode'] } };
    }
    if (name === 'compact' || name === 'clear' || name === 'new') {
        return args ? error(`/${name}`) : { kind: name === 'compact' ? 'compact' : 'clear' };
    }
    if (name === 'help' || name === 'usage' || name === 'context' || name === 'status') {
        return args ? error(`/${name}`) : { kind: 'query', name };
    }
    return { kind: 'error', message: `/${name} is not supported in HAPI's Antigravity sessions. Use /help to see available commands.` };
}

const count = (value: number) => value.toLocaleString('en-US');
const cell = (value: string) => value.replace(/[|\r\n]/g, ' ');

export function formatAgyContext(status: AgyNativeStatus | null): string {
    const context = status?.context;
    if (!context) return 'Antigravity has not reported context usage yet. Try /context again after initialization.';
    return [
        '**Antigravity context**', '',
        `- Used: **${count(context.tokens)} / ${count(context.window)} tokens (${(context.tokens / context.window * 100).toFixed(2)}%)**`,
        `- Remaining: ${count(Math.max(0, context.window - context.tokens))} tokens`,
        ...(status?.model ? [`- Model: ${status.model}`] : []),
    ].join('\n');
}

export function formatAgyUsage(status: AgyNativeStatus | null): string {
    if (!status?.quotas.length) return 'Antigravity has not reported model quota usage yet. Try /usage again after initialization.';
    const labels: Record<string, [string, string]> = {
        'gemini-5h': ['Gemini', '5 hours'], 'gemini-weekly': ['Gemini', 'Weekly'],
        '3p-5h': ['Claude / GPT', '5 hours'], '3p-weekly': ['Claude / GPT', 'Weekly'],
    };
    return [
        '**Antigravity model quota**', '',
        '| Models | Window | Remaining | Resets (UTC) |',
        '| --- | --- | --- | --- |',
        ...status.quotas.map(quota => {
            const [group, window] = labels[quota.id] ?? [cell(quota.id), '—'];
            const reset = quota.resetTime ? new Date(quota.resetTime).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : 'Not reported';
            return `| ${group} | ${window} | ${(quota.remainingFraction * 100).toFixed(2)}% | ${reset} |`;
        }),
        '', 'Models in each group share its quota. Use /context for this conversation’s context usage.',
    ].join('\n');
}

export function formatAgyModels(mode: AgyMode, models: readonly AgyModelSummary[], nativeModel?: string | null): string {
    return [
        '**Antigravity models**', '',
        `Current: ${nativeModel ?? mode.model ?? 'default'}${mode.effort ? ` · effort: ${mode.effort}` : ''}`, '',
        ...getAgyModelChoices(models).map(model => `- \`${model.modelId}\`${model.name && model.name !== model.modelId ? ` — ${model.name}` : ''}${model.supportedEfforts.length ? ` (${model.supportedEfforts.join(', ')})` : ''}`),
        '', 'Use /model <model ID> and /effort <level>. Use default to reset either setting.',
    ].join('\n');
}

export function formatAgyHelp(): string {
    return ['**Antigravity commands in HAPI**', '',
        ...getBuiltinSlashCommands('agy').map(command => `- \`/${command.name}\` — ${command.description}`),
        '', '`/new` is an alias for `/clear`; `/quota` for `/usage`; `/permission` for `/permissions`.',
    ].join('\n');
}

export function formatAgyConfig(mode: AgyMode): string {
    return `Antigravity settings: ${mode.permissionMode} · model: ${mode.model ?? 'default'} · effort: ${mode.effort ?? 'default'}.`;
}
