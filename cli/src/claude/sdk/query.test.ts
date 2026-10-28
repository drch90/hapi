import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const killProcessMock = vi.fn(async (child: any) => {
    child.killed = true
    child.stdout.end()
    child.emit('close', 0)
})

vi.mock('node:child_process', () => ({
    ...require('node:child_process'),
    spawn: spawnMock
}))

vi.mock('@/utils/process', () => ({
    isProcessAlive: () => false,
    isWindows: () => false,
    killProcess: async () => true,
    killProcessByChildProcess: killProcessMock
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env
}))

vi.mock('../utils/mcpConfig', () => ({
    appendMcpConfigArg: () => null
}))

function createFakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        stdout: PassThrough
        stderr: PassThrough
        killed: boolean
    }

    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    return child
}

afterEach(() => {
    vi.clearAllMocks()
    delete process.env.HAPI_CLAUDE_PATH
})

describe('Query', () => {
    it('writes a UUID user message without interrupting the process', async () => {
        const { Query } = await import('./query')
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const sent: string[] = []
        stdin.on('data', chunk => sent.push(chunk.toString()))
        const query = new Query(stdin, stdout, Promise.resolve())
        const message = { type: 'user' as const, uuid: 'a3a8eafd-3cef-4618-a591-2b5bbff488cf', message: { role: 'user' as const, content: 'new direction' } }
        expect(query.sendUserMessage(message)).toBe(true)
        expect(sent.map(line => JSON.parse(line))).toEqual([message])
        stdin.end()
        expect(query.sendUserMessage(message)).toBe(false)
        stdout.end()
    })

    it('reads replay echoes and permission cancellation while approval is pending', async () => {
        const { Query } = await import('./query')
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        let permissionSignal: AbortSignal | undefined
        const canCallTool = vi.fn(async (_name, _input, options) => {
            permissionSignal = options.signal
            await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
            return { behavior: 'deny' as const, message: 'cancelled' }
        })
        const query = new Query(stdin, stdout, Promise.resolve(), canCallTool)
        stdout.write(JSON.stringify({ type: 'control_request', request_id: 'approval', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }) + '\n')
        await vi.waitFor(() => expect(canCallTool).toHaveBeenCalledOnce())
        const replay = { type: 'user', uuid: 'echo-id', isReplay: true, message: { role: 'user', content: 'guidance' } }
        stdout.write(JSON.stringify(replay) + '\n')
        expect(await query.next()).toEqual({ done: false, value: replay })
        expect(permissionSignal?.aborted).toBe(false)
        stdout.write(JSON.stringify({ type: 'control_cancel_request', request_id: 'approval' }) + '\n')
        await vi.waitFor(() => expect(permissionSignal?.aborted).toBe(true))
        stdout.end()
    })

    it('enables native user replay for the streaming remote transport', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'
        const { query } = await import('./query')
        query({ prompt: { async *[Symbol.asyncIterator]() {} }, options: { replayUserMessages: true } })
        expect(spawnMock.mock.calls[0][1]).toContain('--replay-user-messages')
        child.stdout.end()
        child.emit('close', 0)
    })

    it('surfaces an asynchronous broken stdin pipe through the response stream', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'
        const { query } = await import('./query')
        const response = query({ prompt: { async *[Symbol.asyncIterator]() {} } })
        child.stdin.emit('error', new Error('broken stdin pipe'))
        await expect(response.next()).rejects.toThrow('broken stdin pipe')
        expect(child.killed).toBe(true)
    })

    it('preserves externally set errors even if the process exits cleanly', async () => {
        const { Query } = await import('./query')
        const stdout = new PassThrough()
        const query = new Query(null, stdout, Promise.resolve())

        query.setError(new Error('prompt failed'))
        stdout.end()

        await expect(query.next()).rejects.toThrow('prompt failed')
    })

    it('propagates prompt stream failures through query()', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        const prompt = {
            async *[Symbol.asyncIterator]() {
                yield { type: 'user', message: { role: 'user', content: 'hello' } }
                throw new Error('prompt failed')
            }
        }

        const result = query({ prompt })

        await expect(result.next()).rejects.toThrow('prompt failed')
    })

    it('fails fast after cleanup timeout when prompt cleanup hangs', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        killProcessMock.mockReturnValueOnce(new Promise<void>(() => {}))
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        const prompt = {
            async *[Symbol.asyncIterator]() {
                yield { type: 'user', message: { role: 'user', content: 'hello' } }
                throw new Error('prompt failed')
            }
        }

        const result = query({ prompt, options: { promptFailureCleanupTimeoutMs: 10 } })

        await expect(result.next()).rejects.toThrow('prompt failed')
    })

    it('places additional launch arguments before HAPI settings', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        query({
            prompt: 'hello',
            options: {
                additionalArgs: ['--plugin-dir', '/tmp/plugin'],
                settingsPath: '/tmp/hapi-settings.json'
            }
        })

        const args = spawnMock.mock.calls[0][1] as string[]
        expect(args.indexOf('--plugin-dir')).toBeLessThan(args.indexOf('--settings'))
        child.stdout.end()
        child.emit('close', 0)
    })
})
