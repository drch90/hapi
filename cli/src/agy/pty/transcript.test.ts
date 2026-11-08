import { describe, expect, it } from 'vitest';
import { AgyTranscriptCursor, decodeAgyStep, matchesAgyReceipt, type AgyNativeStep } from './transcript';

function varint(value: number): number[] {
    const result: number[] = [];
    do { const next = value % 128; value = Math.floor(value / 128); result.push(next | (value ? 128 : 0)); } while (value);
    return result;
}
const number = (field: number, value: number) => Uint8Array.from([...varint(field * 8), ...varint(value)]);
const message = (field: number, ...parts: Uint8Array[]) => {
    const bytes = parts.flatMap(part => [...part]);
    return Uint8Array.from([...varint(field * 8 + 2), ...varint(bytes.length), ...bytes]);
};
const string = (field: number, value: string) => message(field, new TextEncoder().encode(value));
const decode = (...parts: Uint8Array[]) => decodeAgyStep({ idx: 3, step_type: 132, status: 9, step_format: 0,
    step_payload: Uint8Array.from(parts.flatMap(part => [...part])) });

describe('native Antigravity trajectory', () => {
    it('reads a pending approval with the real tool identity before any grant exists', () => {
        const step = decode(number(1, 132), number(4, 9),
            message(5, message(4, string(1, 'call-native'), string(2, 'run_command'), string(3, '{"CommandLine":"echo hello"}'))),
            message(56, message(21, message(1, string(1, 'command'), string(2, 'echo hello')), string(5, 'Print hello'))));
        expect(step).toMatchObject({ terminal: false, tool: { id: 'call-native', name: 'run_command', input: { CommandLine: 'echo hello' } },
            permission: { kind: 'permission', variant: 21, action: 'command', target: 'echo hello' } });
        expect(step.decision).toBeUndefined();
    });

    it('reads once-only allow even when the native scope enum is omitted', () => {
        const step = decode(number(4, 3), message(147, message(2, message(21, number(1, 1)))));
        expect(step).toMatchObject({ terminal: true, failed: false, decision: { approved: true } });
        expect(step.permission).toBeUndefined();
    });

    it('does not infer tool success from a result container while it is running', () => {
        const step = decode(number(4, 2), message(140, message(2, message(3, string(1, 'render-only')))));
        expect(step.terminal).toBe(false);
    });

    it('decodes incremental planner text and thinking independently', () => {
        const step = decode(number(1, 15), number(4, 8), message(20, string(1, 'Hel'), string(3, 'Consider the request'), string(6, 'bot-id')));
        expect(step).toMatchObject({ text: 'Hel', thinking: 'Consider the request', messageId: 'bot-id', terminal: false });
    });

    it('requires exact receipts, with the native prefix allowed only in Plan', () => {
        const step = decode(number(1, 14), number(4, 3), message(5, number(33, 1)), message(19, string(2, '/plan hello')));
        expect(step.interrupting).toBe(true);
        expect(matchesAgyReceipt(step, 'hello', 'plan')).toBe(true);
        expect(matchesAgyReceipt(step, 'hello', 'auto')).toBe(false);
        expect(matchesAgyReceipt(step, 'hell', 'plan')).toBe(false);
        expect(matchesAgyReceipt({ ...step, invalidated: true }, 'hello', 'plan')).toBe(false);
    });

    it.each([
        { input: 'hello\n', receipt: 'hello', mode: 'auto' },
        { input: '\n  hello\n    world\n\n', receipt: 'hello\n    world', mode: 'default' },
        { input: '  hello\r\n    world\r\n', receipt: 'hello\n    world', mode: 'auto' },
        { input: 'hello\n    world', receipt: '\nhello\r\n    world\n', mode: 'default' },
        { input: '\n  hello\n    world\n\n', receipt: '/plan hello\n    world', mode: 'plan' },
        { input: '\n  hello\n    world\n\n', receipt: '/plan \n  hello\n    world', mode: 'plan' },
        { input: `  ${'line\n'.repeat(20)}\n`, receipt: `  ${'line\n'.repeat(20).trimEnd()}`, mode: 'auto' },
    ])('matches native boundary whitespace normalization: $mode, $input', ({ input, receipt, mode }) => {
        const step = decode(number(1, 14), number(4, 3), message(19, string(2, receipt)));
        expect(matchesAgyReceipt(step, input, mode)).toBe(true);
    });

    it.each([
        { input: 'hello world', receipt: 'hello  world', mode: 'auto' },
        { input: 'hello\n    world', receipt: 'hello\nworld', mode: 'auto' },
        { input: 'hello\nworld', receipt: 'hello world', mode: 'auto' },
        { input: 'hello\nworld\n', receipt: 'hello', mode: 'auto' },
        { input: 'hello\n', receipt: '/plan hello', mode: 'auto' },
        { input: ' \n', receipt: '', mode: 'auto' },
    ])('rejects receipts with changed or empty content: $input, $receipt', ({ input, receipt, mode }) => {
        const step = decode(number(1, 14), number(4, 3), message(19, string(2, receipt)));
        expect(matchesAgyReceipt(step, input, mode)).toBe(false);
    });

    it('keeps unknown interactions unsupported and handles failed tools without output', () => {
        expect(decode(message(56, message(23))).permission).toMatchObject({ kind: 'unsupported', variant: 23 });
        expect(decode(number(4, 7), message(31, string(1, 'permission denied')))).toMatchObject({ terminal: true, failed: true, error: 'permission denied' });
    });

    it('rejects unknown storage formats and malformed protobufs', () => {
        expect(() => decodeAgyStep({ idx: 0, step_type: 0, status: 0, step_format: 1, step_payload: new Uint8Array() })).toThrow('Unsupported');
        expect(() => decode(Uint8Array.from([0x9a, 1, 8, 1]))).toThrow('Truncated');
        expect(() => decode(Uint8Array.from([0]))).toThrow('Invalid');
    });

    it('pages appended rows and revisits an earlier unfinished step in place', async () => {
        const base = decode(number(1, 15), number(4, 3));
        const rows: AgyNativeStep[] = Array.from({ length: 514 }, (_, index) => ({ ...base, index, text: `row-${index}` }));
        rows[1] = { ...rows[1]!, status: 8, terminal: false, text: 'partial' };
        const source = { maxIndex: async () => rows.length - 1, read: async (from: number) => rows.slice(from, from + 512), close() {} };
        const cursor = new AgyTranscriptCursor(source, 1);
        await cursor.refresh();
        expect(cursor.steps.size).toBe(513);
        expect(cursor.steps.has(0)).toBe(false);
        expect(cursor.settled).toBe(false);
        rows[1] = { ...rows[1]!, status: 3, terminal: true, text: 'complete' };
        await cursor.refresh();
        expect(cursor.steps.get(1)?.text).toBe('complete');
        expect(cursor.settled).toBe(true);
    });
});
