import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

type Field = { wire: number; value: Uint8Array | bigint };

/** The native SQLite payload is a complete Step protobuf. Read only the
 * observed fields; signatures and opaque tool payloads are never rendered. */
class Proto {
    readonly fields = new Map<number, Field[]>();
    constructor(bytes: Uint8Array = new Uint8Array()) {
        if (bytes.length > 32 * 1024 * 1024) throw new Error('Antigravity step exceeds the supported size');
        let offset = 0;
        const varint = (): bigint => {
            let value = 0n;
            for (let shift = 0n; shift < 70n; shift += 7n) {
                const byte = bytes[offset++];
                if (byte === undefined) throw new Error('Truncated Antigravity protobuf');
                value |= BigInt(byte & 127) << shift;
                if (byte < 128) return value;
            }
            throw new Error('Invalid Antigravity protobuf varint');
        };
        while (offset < bytes.length) {
            const tag = Number(varint());
            const number = Math.floor(tag / 8);
            const wire = tag & 7;
            if (!Number.isSafeInteger(tag) || number < 1) throw new Error('Invalid Antigravity protobuf field');
            let value: Field['value'];
            if (wire === 0) value = varint();
            else if (wire === 1 || wire === 2 || wire === 5) {
                const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : 4;
                if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) throw new Error('Truncated Antigravity protobuf field');
                value = bytes.subarray(offset, offset + length);
                offset += length;
            } else throw new Error(`Unsupported Antigravity protobuf wire type ${wire}`);
            const fields = this.fields.get(number) ?? [];
            fields.push({ wire, value });
            this.fields.set(number, fields);
        }
    }
    bytes(field: number): Uint8Array | undefined {
        const value = this.fields.get(field)?.find(value => value.wire === 2)?.value;
        return value instanceof Uint8Array ? value : undefined;
    }
    message(field: number): Proto { return new Proto(this.bytes(field)); }
    messages(field: number): Proto[] {
        return (this.fields.get(field) ?? []).filter(value => value.wire === 2)
            .map(value => new Proto(value.value as Uint8Array));
    }
    text(field: number): string {
        const bytes = this.bytes(field);
        return bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : '';
    }
    number(field: number): number | undefined {
        const value = this.fields.get(field)?.find(value => value.wire === 0)?.value;
        if (typeof value !== 'bigint' || value > BigInt(Number.MAX_SAFE_INTEGER)) return;
        return Number(value);
    }
}

export type AgyNativePermission = {
    kind: 'permission' | 'unsupported';
    variant: number;
    action: string;
    target: string;
    description: string;
    reason: string;
};

export type AgyNativeStep = {
    index: number;
    type: number;
    status: number;
    terminal: boolean;
    failed: boolean;
    invalidated: boolean;
    createdAt: number | undefined;
    executionId: string;
    userText: string;
    interrupting: boolean;
    text: string;
    thinking: string;
    messageId: string;
    model: string;
    tool?: { id: string; name: string; input: unknown; summary: string; output: string };
    permission?: AgyNativePermission;
    decision?: { approved: boolean; target: string };
    error: string;
};

export type AgyNativeRow = {
    idx: number;
    step_type: number;
    status: number;
    step_format: number;
    step_payload: Uint8Array;
};

export function decodeAgyStep(row: AgyNativeRow): AgyNativeStep {
    if (row.step_format !== 0) throw new Error(`Unsupported Antigravity step format: ${row.step_format}`);
    const step = new Proto(row.step_payload);
    const type = step.number(1) ?? row.step_type;
    const status = step.number(4) ?? row.status;
    const metadata = step.message(5);
    const user = step.message(19);
    const planner = step.message(20);
    const tool = metadata.bytes(29) ? metadata.message(29) : metadata.message(4);
    const error = step.message(31);
    const created = metadata.message(1);
    const model = metadata.message(24);
    const requested = step.message(56);
    const variant = requested.fields.keys().next().value as number | undefined;
    const spec = requested.message(21);
    const resource = spec.message(1);
    const decision = step.messages(147).map(value => value.message(2)).find(value => value.bytes(21))?.message(21);
    let input: unknown = tool.text(3);
    if (typeof input === 'string' && input) {
        try { input = JSON.parse(input); } catch { /* Preserve the native argument string for inspection. */ }
    }
    const terminal = [3, 4, 5, 6, 7, 12].includes(status);
    const errorText = error.text(1) || error.text(2) || error.text(3) || error.text(9);
    return {
        index: row.idx, type, status, terminal,
        failed: [4, 5, 6, 7, 12].includes(status), invalidated: status === 4 || status === 5,
        createdAt: created.number(1) === undefined ? undefined : created.number(1)! * 1000 + (created.number(2) ?? 0) / 1e6,
        executionId: metadata.text(12),
        userText: user.text(2) || user.messages(3).map(item => item.text(1)).join(''),
        interrupting: metadata.number(33) === 1,
        text: planner.text(8) || planner.text(1),
        thinking: planner.text(3) || planner.text(16),
        messageId: planner.text(6), model: model.text(20) || model.text(8) || model.text(12),
        ...(tool.text(1) && tool.text(2) ? { tool: {
            id: tool.text(1), name: tool.text(2), input,
            summary: metadata.text(30),
            output: step.message(140).message(2).text(1) || errorText,
        } } : {}),
        ...(status === 9 && variant !== undefined ? { permission: {
            kind: variant === 21 ? 'permission' as const : 'unsupported' as const,
            variant, action: resource.text(1), target: resource.text(2),
            description: spec.text(5), reason: spec.text(4),
        } } : {}),
        ...(decision ? { decision: { approved: decision.number(1) === 1, target: decision.text(6) } } : {}),
        error: errorText,
    };
}

export function matchesAgyReceipt(step: AgyNativeStep, text: string, mode: string): boolean {
    return step.type === 14 && !step.invalidated && (step.userText === text || mode === 'plan' && step.userText === `/plan ${text}`);
}

export interface AgyTranscriptSource {
    maxIndex(): Promise<number>;
    read(fromIndex: number): Promise<AgyNativeStep[]>;
    title?(): Promise<string | null>;
    close(): void;
}

/** Revisit unfinished rows and the trailing row while reading appended pages.
 * Native steps mutate in place; an append-only cursor would lose streamed text,
 * approval requests and tool completion. */
export class AgyTranscriptCursor {
    readonly steps = new Map<number, AgyNativeStep>();
    private nextIndex: number;
    constructor(private readonly source: AgyTranscriptSource, readonly startIndex: number) {
        this.nextIndex = startIndex;
    }

    async refresh(all = false): Promise<void> {
        if (this.nextIndex > this.startIndex && await this.source.maxIndex() < this.nextIndex - 1) {
            throw new Error('Antigravity rewound the native trajectory during delivery');
        }
        let from = all ? this.startIndex : Math.max(this.startIndex, this.nextIndex - 1);
        if (!all) for (const step of this.steps.values()) if (!step.terminal) from = Math.min(from, step.index);
        while (true) {
            const page = await this.source.read(from);
            for (const step of page) {
                this.steps.set(step.index, step);
                this.nextIndex = Math.max(this.nextIndex, step.index + 1);
            }
            if (page.length < 512) break;
            from = page[page.length - 1]!.index + 1;
        }
    }

    get settled(): boolean {
        return [...this.steps.values()].every(step => step.terminal);
    }
}

export class AgyTranscript {
    private db: Database | null = null;
    private summaries: Database | null = null;
    constructor(readonly sessionId: string, private readonly directory = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')) {
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(sessionId)) throw new Error('Invalid native Antigravity session ID');
    }
    async open(): Promise<void> {
        if (this.db) return;
        const { Database } = await import('bun:sqlite');
        this.db = new Database(join(this.directory, `${this.sessionId}.db`), { readonly: true });
        this.db.exec('PRAGMA busy_timeout = 100');
        const meta = this.db.query('SELECT cascade_id FROM trajectory_meta LIMIT 1').get() as { cascade_id: string } | null;
        if (meta?.cascade_id !== this.sessionId) throw new Error('Antigravity conversation identity does not match its trajectory');
    }
    async maxIndex(): Promise<number> {
        await this.open();
        const row = this.db!.query('SELECT MAX(idx) AS value FROM steps').get() as { value: number | null };
        return row.value ?? -1;
    }
    async read(fromIndex: number): Promise<AgyNativeStep[]> {
        await this.open();
        const rows = this.db!.query('SELECT idx, step_type, status, step_format, step_payload FROM steps WHERE idx >= ? ORDER BY idx LIMIT 512').all(fromIndex) as AgyNativeRow[];
        return rows.map(decodeAgyStep);
    }
    async title(): Promise<string | null> {
        try {
            if (!this.summaries) {
                const { Database } = await import('bun:sqlite');
                this.summaries = new Database(join(this.directory, '..', 'conversation_summaries.db'), { readonly: true });
                this.summaries.exec('PRAGMA busy_timeout = 50');
            }
            const row = this.summaries.query('SELECT title FROM conversation_summaries WHERE conversation_id = ?').get(this.sessionId) as { title: string } | null;
            return row?.title ?? null;
        } catch { return null; } // Title enrichment must not interrupt delivery.
    }
    close(): void { this.db?.close(); this.db = null; this.summaries?.close(); this.summaries = null; }
}
