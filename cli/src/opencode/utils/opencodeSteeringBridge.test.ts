import { describe, expect, it, vi } from 'vitest';
import { opencodeSteerMessageId, sendOpencodeSteer, supportsOpencodeSteering } from './opencodeSteeringBridge';

const target = { baseUrl: 'http://127.0.0.1:4321', password: 'test-password', sessionId: 'ses_test' };

function receipt(localId = 'local-1') {
    return { data: { id: opencodeSteerMessageId(target.sessionId, localId), sessionID: target.sessionId, type: 'user', delivery: 'steer' } };
}

describe('OpenCode native steering bridge', () => {
    it.each(['2.2.5', '2.2.6', '2.3.0'])('enables the verified native inbox contract for %s', version => {
        expect(supportsOpencodeSteering(version)).toBe(true);
    });

    it.each([undefined, '', '1.19.5', '2.0.29', '2.2.4', '2.2.5-dev', '3.0.0'])('does not assume the inbox contract for %s', version => {
        expect(supportsOpencodeSteering(version)).toBe(false);
    });

    it('sends native steering with a stable identity and does not start a new execution', async () => {
        const fetchImpl = vi.fn(async () => Response.json(receipt()));
        expect(await sendOpencodeSteer(target, 'local-1', 'new guidance @/tmp/upload.png', fetchImpl)).toEqual({ kind: 'accepted' });
        expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:4321/api/session/ses_test/prompt', {
            method: 'POST',
            headers: {
                authorization: `Basic ${Buffer.from('opencode:test-password').toString('base64')}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ id: opencodeSteerMessageId('ses_test', 'local-1'), text: 'new guidance @/tmp/upload.png', delivery: 'steer', resume: false }),
            redirect: 'error',
            signal: expect.any(AbortSignal),
        });
        expect(opencodeSteerMessageId('ses_test', 'local-1')).toBe(opencodeSteerMessageId('ses_test', 'local-1'));
        expect(opencodeSteerMessageId('other-session', 'local-1')).not.toBe(opencodeSteerMessageId('ses_test', 'local-1'));
        expect(opencodeSteerMessageId('ses_test', 'local-2')).not.toBe(opencodeSteerMessageId('ses_test', 'local-1'));
    });

    it.each([400, 401, 404, 409])('treats HTTP %i as a definite rejection', async status => {
        expect(await sendOpencodeSteer(target, 'local-1', 'guidance', async () => new Response('', { status })))
            .toEqual({ kind: 'rejected', error: `OpenCode steer request failed (${status})` });
    });

    it.each([500, 502, 503])('holds HTTP %i because native admission may have happened', async status => {
        expect(await sendOpencodeSteer(target, 'local-1', 'guidance', async () => new Response('', { status })))
            .toMatchObject({ kind: 'indeterminate' });
    });

    it('holds a connection failure and never retries the POST automatically', async () => {
        const fetchImpl = vi.fn(async () => { throw new Error('connection lost'); });
        expect(await sendOpencodeSteer(target, 'local-1', 'guidance', fetchImpl)).toMatchObject({ kind: 'indeterminate' });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it.each([
        {},
        { data: { ...receipt().data, id: 'msg_other' } },
        { data: { ...receipt().data, sessionID: 'ses_other' } },
        { data: { ...receipt().data, delivery: 'queue' } },
    ])('requires a matching native admission receipt: %j', async payload => {
        expect(await sendOpencodeSteer(target, 'local-1', 'guidance', async () => Response.json(payload)))
            .toMatchObject({ kind: 'indeterminate' });
    });

    it('holds an unreadable success response', async () => {
        expect(await sendOpencodeSteer(target, 'local-1', 'guidance', async () => new Response('{')))
            .toMatchObject({ kind: 'indeterminate' });
    });
});
