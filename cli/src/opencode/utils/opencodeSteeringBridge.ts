import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isObject } from '@hapi/protocol';
import type { FetchLike } from './opencodeCompactBridge';

export type OpencodeSteerTarget = {
    baseUrl: string;
    password: string;
    sessionId: string;
};

export type OpencodeSteerResult =
    | { kind: 'accepted' }
    | { kind: 'rejected'; error: string }
    | { kind: 'indeterminate'; error: string };

/** The v2 inbox admission contract was verified against OpenCode 2.2.5. */
export function supportsOpencodeSteering(version: string | undefined): boolean {
    const match = /^2\.(\d+)\.(\d+)$/.exec(version ?? '');
    return Boolean(match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 5)));
}

/** Repeated steer requests retain the same native input identity. */
export function opencodeSteerMessageId(sessionId: string, localId: string): string {
    return `msg_hapi_${createHash('sha256').update(JSON.stringify([sessionId, localId])).digest('hex')}`;
}

/**
 * OpenCode 2.2.5 rejects concurrent ACP prompts. Its REST prompt endpoint
 * admits input to the native inbox and returns before execution completes.
 * `resume: false` lets the active execution consume the steer without starting
 * an unobserved execution if the foreground ACP turn ends during admission.
 */
export async function sendOpencodeSteer(
    target: OpencodeSteerTarget,
    localId: string,
    text: string,
    fetchImpl: FetchLike = fetch,
): Promise<OpencodeSteerResult> {
    const id = opencodeSteerMessageId(target.sessionId, localId);
    try {
        const response = await fetchImpl(`${target.baseUrl}/api/session/${encodeURIComponent(target.sessionId)}/prompt`, {
            method: 'POST',
            headers: {
                authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString('base64')}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ id, text, delivery: 'steer', resume: false }),
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
            const error = `OpenCode steer request failed (${response.status})`;
            // A server failure can follow durable admission. Never replay it.
            return { kind: response.status >= 500 ? 'indeterminate' : 'rejected', error };
        }
        const payload: unknown = await response.json();
        const input = isObject(payload) && isObject(payload.data) ? payload.data : null;
        if (input?.id !== id || input.sessionID !== target.sessionId || input.type !== 'user' || input.delivery !== 'steer') {
            return { kind: 'indeterminate', error: 'OpenCode did not confirm the submitted steer' };
        }
        return { kind: 'accepted' };
    } catch {
        // This includes an interrupted body read after the server accepted it.
        return { kind: 'indeterminate', error: 'OpenCode steer delivery could not be confirmed' };
    }
}
