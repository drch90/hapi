/** Input may have reached native Enter. It must never be automatically replayed. */
export class AgyIndeterminateDeliveryError extends Error {}

export function normalizeAgyInput(text: string): string {
    const normalized = text.replace(/\r\n?/g, '\n');
    if (!normalized.trim()) throw new Error('Antigravity requires a non-empty message');
    // All text is bracketed-pasted. Embedded terminal controls (including a
    // forged paste terminator) must not become native keystrokes.
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(normalized)) {
        throw new Error('Antigravity messages cannot contain terminal control characters');
    }
    return normalized;
}
