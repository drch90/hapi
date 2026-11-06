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
