import { describe, expect, it } from 'vitest';
import { formatAgyContext, formatAgyHelp, formatAgyModels, formatAgyUsage, resolveAgyCommand } from './commands';
import { parseAgyNativeStatus } from './pty/nativeStatus';

describe('Antigravity commands', () => {
    it.each(['usage', 'context', 'help', 'status', 'model', 'effort', 'permissions'])('resolves /%s as a query, not a model prompt', name => {
        expect(resolveAgyCommand(`  /${name}\n`)).toEqual({ kind: 'query', name });
    });

    it('keeps native aliases and ordinary messages distinct', () => {
        expect(resolveAgyCommand('/quota')).toEqual({ kind: 'query', name: 'usage' });
        expect(resolveAgyCommand('/new')).toEqual({ kind: 'clear' });
        expect(resolveAgyCommand('/compact')).toEqual({ kind: 'compact' });
        expect(resolveAgyCommand('/permission')).toEqual({ kind: 'query', name: 'permissions' });
        expect(resolveAgyCommand('Explain /usage')).toBeNull();
        expect(resolveAgyCommand('Please compact the examples in this file')).toBeNull();
    });

    it('translates model and mode controls into session-only settings', () => {
        expect(resolveAgyCommand('/model gemini-3.8-flash')).toEqual({ kind: 'config', updates: { model: 'gemini-3.8-flash' } });
        expect(resolveAgyCommand('/model default')).toEqual({ kind: 'config', updates: { model: null } });
        expect(resolveAgyCommand('/effort high')).toEqual({ kind: 'config', updates: { effort: 'high' } });
        expect(resolveAgyCommand('/effort default')).toEqual({ kind: 'config', updates: { effort: null } });
        expect(resolveAgyCommand('/permissions default')).toEqual({ kind: 'config', updates: { permissionMode: 'request-review' } });
        expect(resolveAgyCommand('/auto')).toEqual({ kind: 'config', updates: { permissionMode: 'auto' } });
        expect(resolveAgyCommand('/plan')).toEqual({ kind: 'config', updates: { permissionMode: 'plan' } });
        expect(resolveAgyCommand('/plan off')).toEqual({ kind: 'config', updates: { permissionMode: 'request-review' } });
        expect(resolveAgyCommand('/plan Research the API\nInclude tests')).toEqual({ kind: 'config', updates: { permissionMode: 'plan' }, prompt: 'Research the API\nInclude tests' });
    });

    it.each(['/clear', '/usage', '/permissions always-proceed'])('keeps /plan %s as task text instead of another control operation', task => {
        const command = resolveAgyCommand(`/plan ${task}`);
        expect(command).toMatchObject({ kind: 'config', updates: { permissionMode: 'plan' }, prompt: expect.stringContaining(task) });
        if (command?.kind !== 'config' || !command.prompt) throw new Error('Expected a Plan prompt');
        expect(resolveAgyCommand(command.prompt)).toBeNull();
        expect(command.prompt).not.toMatch(/^\s*\//);
    });

    it.each(['/usage now', '/compact extra', '/clear everything', '/effort extreme', '/permissions unchecked', '/model one two', '/model unsafe\x03'])('rejects invalid command arguments: %s', text => {
        expect(resolveAgyCommand(text)?.kind).toBe('error');
    });

    it('rejects terminal-only or unknown commands with an actionable response', () => {
        expect(resolveAgyCommand('/logout')).toEqual({ kind: 'error', message: expect.stringContaining('/help') });
        expect(resolveAgyCommand('/does-not-exist anything')?.kind).toBe('error');
        expect(formatAgyHelp()).toContain('`/usage`');
        expect(formatAgyHelp()).toContain('`/clear`');
    });

    it('shows the native context measurement and never substitutes cumulative tokens', () => {
        const status = parseAgyNativeStatus(JSON.stringify({ agent_state: 'idle', model: { display_name: 'Test model' }, context_window: {
            context_window_size: 1_048_576, used_percentage: 0.9569168090820312, total_input_tokens: 5_000_000,
            current_usage: { input_tokens: 6949, cache_read_input_tokens: 1000 },
        } }));
        expect(formatAgyContext(status)).toContain('10,034 / 1,048,576 tokens (0.96%)');
        expect(formatAgyContext(status)).not.toContain('5,000,000');
        expect(formatAgyContext(null)).toContain('not reported');
        expect(formatAgyContext(parseAgyNativeStatus('{"agent_state":"idle","context_window":{"context_window_size":100000,"used_percentage":0}}'))).toContain('0 / 100,000');
    });

    it('renders native quota reset times without exposing account fields or confusing quota with context', () => {
        const status = parseAgyNativeStatus(JSON.stringify({ agent_state: 'idle', email: 'private@example.test', quota: {
            'gemini-5h': { remaining_fraction: 0.9765905, reset_time: '2026-11-07T05:58:02Z' },
            '3p-weekly': { remaining_fraction: 1 },
        } }));
        const output = formatAgyUsage(status);
        expect(output).toContain('| Gemini | 5 hours | 97.66% | 2026-11-07 05:58:02 |');
        expect(output).toContain('| Claude / GPT | Weekly | 100.00% | Not reported |');
        expect(output).not.toContain('private@example.test');
        expect(output).toContain('/context');
        expect(formatAgyUsage(null)).toContain('not reported');
    });

    it('uses the discovered model catalog', () => {
        const output = formatAgyModels({ permissionMode: 'auto', model: 'gemini-next', effort: 'high' }, [
            { modelId: 'gemini-next-low', name: 'Next (Low)' },
            { modelId: 'gemini-next-high', name: 'Next (High)' },
        ]);
        expect(output).toContain('`gemini-next`');
        expect(output).toContain('low, high');
    });
});
