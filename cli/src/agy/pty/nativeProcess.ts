import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPtyManager } from '@/agent/AgentPtyManager';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';
import { killProcessTreeByPid } from '@/utils/process';
import { logger } from '@/ui/logger';
import { listAgyModels } from '@/modules/common/agyModels';
import type { AgyMode, PermissionMode } from '../types';
import { AgyIndeterminateDeliveryError, normalizeAgyInput } from './delivery';
import { AgyTerminalScreen, readAgyTerminalState, type AgyNativeMode, type AgyTerminalPermission, type AgyTerminalState } from './terminalState';
import { agyStatusLine, expectedAgyModelNames, isAgyStatusReadyForInput, matchesAgyStatusModel, parseAgyNativeStatus, type AgyNativeStatus } from './nativeStatus';

export interface AgyProcess {
    readonly sessionId: string | null;
    readonly model: string | null;
    readonly state: AgyTerminalState;
    readonly failure: Error | null;
    readonly revision: number;
    start(): Promise<void>;
    refreshStatus(): Promise<void>;
    setMode(mode: PermissionMode): Promise<void>;
    submit(text: string, steer: boolean, beforeSubmit: () => Promise<void>): Promise<void>;
    respond(menu: AgyTerminalPermission, approved: boolean, revalidate: () => Promise<boolean>): Promise<void>;
    waitForChange(timeoutMs?: number): Promise<void>;
    close(): Promise<void>;
}

export function nativeModeFor(mode: PermissionMode): AgyNativeMode {
    return mode === 'auto' || mode === 'plan' ? mode : 'default';
}

export function agyLaunchArgs(mode: AgyMode, logPath: string, sessionId: string | null, statusPath: string): string[] {
    if (sessionId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(sessionId)) {
        throw new Error('Invalid native Antigravity session ID');
    }
    const nativeMode = nativeModeFor(mode.permissionMode);
    return [
        '--settings', JSON.stringify({ agentMode: nativeMode === 'default' ? '' : nativeMode,
            toolPermission: 'request-review', queuedMessages: 'send-immediately', statusLine: agyStatusLine(statusPath) }),
        '--log-file', logPath,
        ...(sessionId ? [`--conversation=${sessionId}`] : []),
        ...(mode.permissionMode === 'always-proceed' ? ['--dangerously-skip-permissions'] : []),
        ...(mode.model ? ['--model', mode.model] : []),
        ...(mode.effort ? ['--effort', mode.effort] : []),
    ];
}

function envForAgy(): Record<string, string> {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    env.GEMINI_FORCE_FILE_STORAGE = 'true';
    env.TERM = 'xterm-256color';
    // Keep forwarded credentials available to tools without entering agy's
    // degraded SSH login path.
    for (const key of ['SSH_CLIENT', 'SSH_CONNECTION', 'SSH_TTY']) delete env[key];
    return env;
}

/** Native once-only options are selected by their labels, never by a fixed
 * menu position. Conversation/persistent pattern grants are not equivalent. */
export function permissionOption(menu: AgyTerminalPermission, approved: boolean): number | null {
    const choices = menu.options.filter(option => approved
        ? /^(?:Yes, |Allow\b)/.test(option.text) && !/always|conversation|persist|settings\.json|workspace|project|global|pattern/i.test(option.text)
        : /^(?:No\b|Cancel\b|Deny\b)/.test(option.text));
    return choices.length === 1 ? choices[0]!.index : null;
}

/** A single owned native terminal. All application keystrokes are serialized;
 * terminal protocol replies carry no user decisions. */
export class NativeAgyProcess implements AgyProcess {
    private readonly pty = new AgentPtyManager();
    private readonly screen = new AgyTerminalScreen();
    private readonly listeners = new Set<() => void>();
    private directory: string | null = null;
    private closed = false;
    private serial: Promise<unknown> = Promise.resolve();
    private closing: Promise<void> | null = null;
    private statusPath: string | null = null;
    private status: AgyNativeStatus | null = null;
    private promptBusy = false;
    failure: Error | null = null;
    sessionId: string | null;
    model: string | null = null;
    state = readAgyTerminalState(this.screen);

    constructor(private readonly cwd: string, private readonly launchMode: AgyMode, private readonly resumeSessionId: string | null) {
        this.sessionId = resumeSessionId;
    }

    get revision(): number { return this.screen.revision; }

    get permissionPending(): boolean {
        return this.sessionId !== null && this.status?.conversationId === this.sessionId && this.status.permissionPending;
    }

    private changed(): void { for (const listener of [...this.listeners]) listener(); }

    private check(): void {
        if (this.closed) throw new Error('Antigravity process stopped');
        if (this.failure) throw this.failure;
    }

    private write(keys: string): void {
        this.check();
        if (!this.pty.isRunning) throw new Error('Antigravity terminal is not running');
        this.pty.write(keys);
    }

    waitForChange(timeoutMs = 75): Promise<void> {
        if (this.closed || this.failure) return Promise.resolve();
        return new Promise(resolve => {
            const done = () => { clearTimeout(timer); this.listeners.delete(done); resolve(); };
            const timer = setTimeout(done, timeoutMs);
            this.listeners.add(done);
        });
    }

    private async until(check: () => boolean, timeoutMs: number, error: string): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (true) {
            this.check();
            if (check()) return;
            if (Date.now() >= deadline) throw new Error(error);
            await this.waitForChange(Math.min(75, deadline - Date.now()));
        }
    }

    private exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.serial.then(() => { this.check(); return operation(); });
        this.serial = result.catch(() => {});
        return result;
    }

    async refreshStatus(): Promise<void> {
        if (!this.statusPath || this.closed) return;
        let text: string;
        try { text = await readFile(this.statusPath, 'utf8'); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        const status = parseAgyNativeStatus(text);
        if (!status) return;
        if (status.conversationId && this.sessionId && status.conversationId !== this.sessionId) {
            throw new Error('Antigravity switched to a different native conversation');
        }
        this.status = status;
        this.sessionId ??= status.conversationId;
        this.model = status.model ? `${status.model}${status.effort && !status.model.toLowerCase().includes(status.effort) ? ` · ${status.effort}` : ''}` : this.model;
    }

    async start(): Promise<void> {
        // runAgy already populated this process's catalog during normalization;
        // reuse it to distinguish the startup placeholder model from selection.
        const catalog = this.launchMode.model ? listAgyModels() : Promise.resolve(null);
        void catalog.catch(() => {});
        this.directory = await mkdtemp(join(tmpdir(), 'hapi-agy-'));
        if (this.closed) await rm(this.directory, { recursive: true, force: true });
        this.check();
        const logPath = join(this.directory, 'native.log');
        this.statusPath = join(this.directory, 'status.json');
        const args = agyLaunchArgs(this.launchMode, logPath, this.sessionId, this.statusPath);
        this.pty.spawn({ command: getAgentLaunchCommand('agy'), args, cwd: this.cwd, env: envForAgy(), cols: this.screen.cols, rows: this.screen.rows,
            onData: data => {
                if (this.closed) return;
                this.screen.write(data);
                this.state = readAgyTerminalState(this.screen);
                if (this.state.kind === 'prompt') {
                    if (this.state.editing) this.state.busy = this.promptBusy;
                    else this.promptBusy = this.state.busy;
                }
                for (const reply of this.screen.takeResponses()) this.pty.write(reply);
                this.changed();
            },
            onError: error => { this.failure = error; this.changed(); },
            onExit: code => {
                if (!this.closed) this.failure = new Error(`Antigravity exited (${code ?? 'signal'})`);
                this.changed();
            },
        });
        const expectedModels = expectedAgyModelNames(this.launchMode, (await catalog)?.availableModels ?? []);
        const deadline = Date.now() + 120_000;
        let trusted = false;
        let bypassConfirmed = this.launchMode.permissionMode !== 'always-proceed';
        while (Date.now() < deadline) {
            this.check();
            await this.refreshStatus();
            if (this.state.kind === 'trust' && !trusted) {
                // The user chose this working directory for the coding session.
                // Only the exact native project-trust menu can take this key.
                trusted = true;
                this.write('\r');
            }
            if (!bypassConfirmed) {
                try {
                    const log = await readFile(logPath, 'utf8');
                    this.sessionId ??= log.match(/Created conversation ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b/i)?.[1] ?? null;
                    bypassConfirmed ||= log.includes('--dangerously-skip-permissions: auto-approving all tool permissions');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
            if (this.state.kind === 'prompt' && !this.state.busy && this.status && isAgyStatusReadyForInput(this.status)
                && (!this.resumeSessionId || this.status.conversationId === this.resumeSessionId)
                && this.status.mode === nativeModeFor(this.launchMode.permissionMode)
                && matchesAgyStatusModel(this.status, expectedModels)
                && (!this.launchMode.effort || this.status.effort === this.launchMode.effort) && bypassConfirmed) {
                // A fresh native session creates its UUID only on first send.
                // Prewarming must not wait for a conversation that does not exist.
                await this.setMode(this.launchMode.permissionMode);
                const footerModel = this.state.footer?.split(/\s{2,}/).at(-1)?.replace(/^(?:accept-edits|auto|plan)\s*·\s*/, '').trim();
                this.model ||= footerModel || this.launchMode.model || null;
                return;
            }
            if (this.state.kind === 'login' && this.state.lines.some(line => /Select login method/.test(line))) {
                throw new Error('Antigravity authentication required. Run agy in a terminal to sign in, then resume this session.');
            }
            await this.waitForChange(250);
        }
        throw new Error('Antigravity did not reach its native input prompt. Check agy 1.5.2 or newer and its terminal login.');
    }

    setMode(mode: PermissionMode): Promise<void> {
        if ((mode === 'always-proceed') !== (this.launchMode.permissionMode === 'always-proceed')) {
            return Promise.reject(new Error('Always Proceed requires restarting the native Antigravity process'));
        }
        return this.exclusive(async () => {
            const expected = nativeModeFor(mode);
            const visited = new Set<AgyNativeMode>();
            while (true) {
                const state = this.state;
                if (state.kind !== 'prompt' || state.busy || state.editor !== '' || state.mode === null) {
                    throw new Error('Antigravity is not at an empty input prompt for mode selection');
                }
                if (state.mode === expected) return;
                if (visited.has(state.mode)) throw new Error(`Antigravity native ${mode} mode is unavailable for this account`);
                visited.add(state.mode);
                const before = state.mode;
                this.write('\x1b[Z'); // Native Shift+Tab; available modes can vary.
                await this.until(() => this.state.kind === 'prompt' && this.state.mode !== before, 3_000,
                    'Antigravity did not confirm the requested mode change');
            }
        });
    }

    submit(text: string, steer: boolean, beforeSubmit: () => Promise<void>): Promise<void> {
        return this.exclusive(async () => {
            const input = normalizeAgyInput(text);
            const ready = () => this.state.kind === 'prompt' && this.state.busy === steer && this.state.editor === '';
            if (!ready()) throw new Error(steer ? 'Antigravity cannot accept guidance while another native dialog owns input' : 'Antigravity input is not ready');
            // Capture the durable receipt baseline under the same input lock.
            await beforeSubmit();
            if (!ready()) throw new Error('Antigravity input changed before submission');
            const before = this.revision;
            let entered = false;
            try {
                this.write(`\x1b[200~${input}\x1b[201~`);
                await this.until(() => this.revision > before && this.state.kind === 'prompt'
                    && this.state.editor !== null && this.state.editor !== '', 5_000,
                'Antigravity did not accept the pasted message');
                if (this.state.kind !== 'prompt' || this.state.busy !== steer) throw new Error('Antigravity input changed while pasting');
                // Enter is deliberately a separate write after the editor paint.
                // That paint confirms the paste, not durable message delivery.
                entered = true;
                this.write('\r');
            } catch (error) {
                // Never retry the paste: if Enter is uncertain, the caller holds
                // the queue row for explicit user resolution. Closing also clears
                // an unsubmitted editor so a later key cannot send it by accident.
                this.failure = entered ? new AgyIndeterminateDeliveryError(String(error)) : error instanceof Error ? error : new Error(String(error));
                this.changed();
                throw this.failure;
            }
        });
    }

    respond(menu: AgyTerminalPermission, approved: boolean, revalidate: () => Promise<boolean>): Promise<void> {
        return this.exclusive(async () => {
            const option = permissionOption(menu, approved);
            if (option === null) throw new Error('Antigravity has no recognized one-time decision for this request');
            const current = () => this.state.kind === 'permission' && this.state.permission?.identity === menu.identity;
            const confirm = async (timeoutMs: number) => {
                const deadline = Date.now() + timeoutMs;
                while (true) {
                    this.check();
                    await this.refreshStatus();
                    if (!current() || !await revalidate() || !current()) throw new Error('Antigravity approval is no longer active');
                    if (this.permissionPending) return;
                    if (Date.now() >= deadline) throw new Error('Antigravity did not confirm an active native approval');
                    await this.waitForChange(Math.min(75, deadline - Date.now()));
                }
            };
            // Native status updates can trail the menu by about 300 ms. Require
            // its structured pending flag as well as the live menu and DB row;
            // assistant output or a stale screen alone cannot authorize keys.
            await confirm(2_000);
            for (let count = 0; this.state.permission?.selected !== option; count++) {
                if (count >= menu.options.length || !current()) throw new Error('Antigravity approval menu changed');
                const selected = this.state.permission!.selected;
                this.write(option < selected ? '\x1b[A' : '\x1b[B');
                await this.until(() => !current() || this.state.permission?.selected !== selected, 2_000,
                    'Antigravity did not confirm the approval selection');
            }
            await confirm(0);
            this.write('\r');
        });
    }

    close(): Promise<void> {
        this.closed = true;
        this.changed();
        this.closing ??= (async () => {
            const pid = this.pty.pid;
            try {
                if (pid && this.pty.isRunning && !await killProcessTreeByPid(pid)) {
                    const error = new Error('Could not confirm that every Antigravity tool subprocess stopped');
                    logger.warn('[agy]', error.message);
                    throw error;
                }
            } finally {
                this.pty.kill();
                if (this.directory) await rm(this.directory, { recursive: true, force: true });
            }
        })();
        return this.closing;
    }
}

export function createAgyProcess(path: string, mode: AgyMode, sessionId: string | null): AgyProcess {
    return new NativeAgyProcess(path, mode, sessionId);
}
