import { isObject, splitAgyModelSelection, type AgyModelSummary } from '@hapi/protocol';
import { z } from 'zod';
import { shellQuote } from '@/modules/common/shellQuote';
import type { AgyNativeMode } from './terminalState';
import type { AgyMode } from '../types';

export type AgyNativeStatus = {
    conversationId: string | null;
    title: string | null;
    mode: AgyNativeMode;
    state: string;
    permissionPending: boolean;
    model: string | null;
    effort: string | null;
    context: { tokens: number; window: number } | null;
    quotas: Array<{ id: string; remainingFraction: number; resetTime: string | null }>;
    version: string | null;
};

const quotaResetTimeSchema = z.iso.datetime({ offset: true });

function parseContext(value: unknown): AgyNativeStatus['context'] {
    if (!isObject(value)) return null;
    const window = value.context_window_size;
    const percentage = value.used_percentage;
    if (typeof window !== 'number' || !Number.isSafeInteger(window) || window <= 0
        || typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0) return null;
    // Native context occupancy differs from the current request's usage and
    // cumulative input/output totals, especially with caches and compaction.
    const tokens = Math.round(percentage * window / 100);
    return Number.isSafeInteger(tokens) && tokens >= 0 ? { tokens, window } : null;
}

function parseQuotas(value: unknown): AgyNativeStatus['quotas'] {
    if (!isObject(value)) return [];
    return Object.entries(value).flatMap(([id, entry]) => {
        if (!isObject(entry)) return [];
        const remainingFraction = entry.remaining_fraction;
        if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)
            || remainingFraction < 0 || remainingFraction > 1) return [];
        const resetTime = quotaResetTimeSchema.safeParse(entry.reset_time);
        return [{ id, remainingFraction, resetTime: resetTime.success ? resetTime.data : null }];
    });
}

/** The native status-line hook is session-only and receives JSON on stdin.
 * A tiny atomic capture needs no Python, jq or extra model/API call. Its output
 * stays in the process's private directory and never enters the chat. */
export function agyStatusLine(path: string) {
    return { type: 'command', command: `cat > ${shellQuote(`${path}.tmp`)} && mv ${shellQuote(`${path}.tmp`)} ${shellQuote(path)}`,
        enabled: true, stack_with_default: true };
}

export function parseAgyNativeStatus(text: string): AgyNativeStatus | null {
    if (text.length > 1_048_576) return null;
    let value: unknown;
    try { value = JSON.parse(text); } catch { return null; }
    if (!isObject(value) || typeof value.agent_state !== 'string') return null;
    const id = value.conversation_id;
    if (id !== undefined && id !== '' && (typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))) return null;
    const mode = value.cycle_mode || 'default';
    if (mode !== 'default' && mode !== 'accept-edits' && mode !== 'auto' && mode !== 'plan') return null;
    const model = isObject(value.model) ? value.model : {};
    return { conversationId: typeof id === 'string' && id ? id : null,
        title: typeof value.conversation_title === 'string' ? value.conversation_title : null,
        mode, state: value.agent_state, permissionPending: value.tool_confirmation_pending === true,
        model: typeof model.display_name === 'string' ? model.display_name : typeof model.id === 'string' ? model.id : null,
        effort: typeof model.effort === 'string' ? model.effort : null,
        context: parseContext(value.context_window), quotas: parseQuotas(value.quota),
        version: typeof value.version === 'string' ? value.version : null };
}

export function expectedAgyModelNames(mode: AgyMode, catalog: readonly AgyModelSummary[]): string[] {
    if (!mode.model) return [];
    return catalog.filter(entry => {
        if (entry.modelId === mode.model) return true;
        const selection = splitAgyModelSelection(entry.modelId);
        return selection.model === mode.model && (!mode.effort || selection.effort === mode.effort);
    }).map(entry => entry.name).filter((name): name is string => Boolean(name));
}

export function matchesAgyStatusModel(status: AgyNativeStatus, names: readonly string[]): boolean {
    if (names.length === 0) return true;
    const normalized = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const displayed = normalized(status.model ?? '');
    const withEffort = normalized(`${status.model ?? ''} ${status.effort ?? ''}`);
    return names.some(name => normalized(name) === displayed || normalized(name) === withEffort);
}

export function isAgyStatusReadyForInput(status: AgyNativeStatus): boolean {
    // A completed Plan can remain "reviewing" while it waits for the user's
    // next message. The native input prompt must also be confirmed by the TUI.
    return !status.permissionPending && (status.state === 'idle' || status.state === 'reviewing');
}
