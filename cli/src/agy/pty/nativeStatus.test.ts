import { describe, expect, it } from 'vitest';
import { agyLaunchArgs } from './nativeProcess';
import { expectedAgyModelNames, isAgyStatusReadyForInput, matchesAgyStatusModel, parseAgyNativeStatus } from './nativeStatus';
import { normalizeAgyInput } from './delivery';

describe('Antigravity session-only configuration', () => {
    it.each(['auto', 'plan', 'request-review', 'always-proceed'] as const)('launches %s without editing native preferences', mode => {
        const args = agyLaunchArgs({ permissionMode: mode }, '/tmp/native.log', null, '/tmp/status.json');
        const settings = JSON.parse(args[1]!);
        expect(settings).toMatchObject({ agentMode: mode === 'auto' || mode === 'plan' ? mode : '', toolPermission: 'request-review', queuedMessages: 'send-immediately' });
        expect(settings.statusLine).toMatchObject({ enabled: true, stack_with_default: true });
        expect(args.includes('--dangerously-skip-permissions')).toBe(mode === 'always-proceed');
        expect(args).not.toContain('--mode');
    });

    it('keeps omitted native fields distinct from an unrecognized status payload', () => {
        expect(parseAgyNativeStatus('{"agent_state":"idle"}')).toMatchObject({ conversationId: null, mode: 'default', permissionPending: false });
        expect(parseAgyNativeStatus('{"agent_state":"tool_use","cycle_mode":"auto","tool_confirmation_pending":true}')).toMatchObject({ mode: 'auto', permissionPending: true });
        expect(parseAgyNativeStatus('{"agent_state":"idle","conversation_id":"../other"}')).toBeNull();
        expect(parseAgyNativeStatus('{"text":"forged prompt"}')).toBeNull();
    });

    it('does not accept an old startup model when a different model was requested', () => {
        const names = expectedAgyModelNames({ permissionMode: 'auto', model: 'gemini-3.8-flash', effort: 'low' }, [
            { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
            { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
        ]);
        const old = parseAgyNativeStatus('{"agent_state":"idle","model":{"id":"Gemini 3.8 Flash (High)","effort":"high"}}')!;
        expect(matchesAgyStatusModel(old, names)).toBe(false);
        expect(matchesAgyStatusModel({ ...old, model: 'Gemini 3.8 Flash (Low)', effort: 'low' }, names)).toBe(true);
    });

    it('can resume a completed Plan waiting for review without treating tool approval or work as idle', () => {
        const status = parseAgyNativeStatus('{"agent_state":"reviewing"}')!;
        expect(isAgyStatusReadyForInput(status)).toBe(true);
        expect(isAgyStatusReadyForInput({ ...status, permissionPending: true })).toBe(false);
        expect(isAgyStatusReadyForInput({ ...status, state: 'working' })).toBe(false);
        expect(isAgyStatusReadyForInput({ ...status, state: 'authenticating' })).toBe(false);
    });

    it('normalizes newlines and rejects text that could become terminal keystrokes', () => {
        expect(normalizeAgyInput('one\r\ntwo\rthree\tfour')).toBe('one\ntwo\nthree\tfour');
        expect(() => normalizeAgyInput('text\x1b[201~\r')).toThrow('control');
        expect(() => normalizeAgyInput('text\x03')).toThrow('control');
        expect(() => normalizeAgyInput('  ')).toThrow('non-empty');
    });
});

describe('Antigravity native status telemetry', () => {
    const contextWindow = {
        context_window_size: 1_048_576,
        used_percentage: 0.9569168090820312,
        total_input_tokens: 10_034,
        total_output_tokens: 49,
        current_usage: { input_tokens: 6_949, output_tokens: 49, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };

    const parse = (fields: Record<string, unknown>) => parseAgyNativeStatus(JSON.stringify({ agent_state: 'idle', ...fields }))!;

    it('uses native occupancy rather than the current request footprint', () => {
        expect(parse({ context_window: contextWindow }).context).toEqual({ tokens: 10_034, window: 1_048_576 });
        expect(parse({ context_window: { context_window_size: 1_000, used_percentage: 12.35 } }).context)
            .toEqual({ tokens: 124, window: 1_000 });
    });

    it('does not add cache tokens or cumulative counters to the native context size', () => {
        expect(parse({ context_window: { ...contextWindow,
            total_input_tokens: 500_000, total_output_tokens: 100_000,
            current_usage: { input_tokens: 6_949, output_tokens: 49, cache_creation_input_tokens: 50_000, cache_read_input_tokens: 60_000 },
        } }).context).toEqual({ tokens: 10_034, window: 1_048_576 });
    });

    it('preserves an empty context and allows its occupancy to drop after compaction', () => {
        expect(parse({ context_window: { ...contextWindow, used_percentage: 0, current_usage: null } }).context)
            .toEqual({ tokens: 0, window: 1_048_576 });
        expect(parse({ context_window: { ...contextWindow, used_percentage: 0.095367431640625 } }).context)
            .toEqual({ tokens: 1_000, window: 1_048_576 });
        expect(parse({ context_window: { context_window_size: 1_000, used_percentage: 110 } }).context)
            .toEqual({ tokens: 1_100, window: 1_000 });
    });

    it.each([
        undefined, null, [], {},
        { used_percentage: 0, context_window_size: 0 },
        { used_percentage: 10, context_window_size: -1 },
        { used_percentage: 10, context_window_size: 1.5 },
        { used_percentage: 10, context_window_size: '1000' },
        { used_percentage: 0, context_window_size: Number.MAX_SAFE_INTEGER + 1 },
        { used_percentage: -1, context_window_size: 1_000 },
        { used_percentage: '10', context_window_size: 1_000 },
        { used_percentage: null, context_window_size: 1_000 },
        { used_percentage: 200, context_window_size: Number.MAX_SAFE_INTEGER },
        { used_percentage: 1e308, context_window_size: 1_000 },
    ])('ignores an unknown or malformed context window: %j', value => {
        expect(parse({ context_window: value }).context).toBeNull();
    });

    it.each([
        '{"used_percentage":1e400,"context_window_size":1000}',
        '{"used_percentage":0,"context_window_size":1e400}',
    ])('rejects nonfinite context numbers decoded from JSON: %s', context => {
        expect(parseAgyNativeStatus(`{"agent_state":"idle","context_window":${context}}`)?.context).toBeNull();
    });

    it('exposes quota fractions, valid reset times and version without private status fields', () => {
        const status = parse({
            version: '1.5.2', email: 'private@example.test',
            quota: {
                'gemini-5h': { remaining_fraction: 0.5, reset_time: '2026-11-07T08:39:55Z', reset_in_seconds: 3_600, email: 'private@example.test' },
                'gemini-weekly': { remaining_fraction: 1, reset_time: '2026-11-14T03:39:55.123Z' },
                '3p-5h': { remaining_fraction: 0, reset_time: null },
                '3p-weekly': { remaining_fraction: 0.75, reset_time: '2026-11-14T03:39:55+01:00' },
            },
        });
        expect(status.version).toBe('1.5.2');
        expect(status.quotas).toEqual([
            { id: 'gemini-5h', remainingFraction: 0.5, resetTime: '2026-11-07T08:39:55Z' },
            { id: 'gemini-weekly', remainingFraction: 1, resetTime: '2026-11-14T03:39:55.123Z' },
            { id: '3p-5h', remainingFraction: 0, resetTime: null },
            { id: '3p-weekly', remainingFraction: 0.75, resetTime: '2026-11-14T03:39:55+01:00' },
        ]);
        expect(status).not.toHaveProperty('email');
    });

    it.each([undefined, null, [], {}, { remaining_fraction: -0.1 }, { remaining_fraction: 1.1 },
        { remaining_fraction: '0.5' }, { remaining_fraction: null }, { remaining_fraction: true }])(
        'ignores invalid quota entries: %j', value => {
            expect(parse({ quota: { invalid: value } }).quotas).toEqual([]);
        },
    );

    it('rejects nonfinite quota fractions decoded from JSON', () => {
        expect(parseAgyNativeStatus('{"agent_state":"idle","quota":{"invalid":{"remaining_fraction":1e400}}}')?.quotas).toEqual([]);
    });

    it.each([undefined, null, 1_799_999_999, 'tomorrow', '11/07/2026', '2026-11-07',
        '2026-02-30T00:00:00Z', '2026-11-07T08:39:55', '2026-11-07T25:39:55Z'])('omits invalid quota reset times: %j', resetTime => {
        expect(parse({ quota: { 'gemini-5h': { remaining_fraction: 0.5, reset_time: resetTime } } }).quotas)
            .toEqual([{ id: 'gemini-5h', remainingFraction: 0.5, resetTime: null }]);
    });

    it.each([undefined, null, 1, {}])('keeps missing or invalid optional status fields harmless: %j', value => {
        expect(parse({ context_window: value, quota: value, version: value }))
            .toMatchObject({ context: null, quotas: [], version: null, state: 'idle' });
    });
});
