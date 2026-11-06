import { describe, expect, it } from 'vitest';
import { AgyTerminalScreen, readAgyTerminalState } from './terminalState';
import { permissionOption } from './nativeProcess';

function paint(lines: string[], cursor = { row: lines.length - 3, col: 2 }): AgyTerminalScreen {
    const screen = new AgyTerminalScreen(100, 30);
    screen.write(`\x1b[H\x1b[2J${lines.join('\r\n')}\x1b[${cursor.row + 1};${cursor.col + 1}H`);
    return screen;
}
const separator = '─'.repeat(100);

describe('Antigravity native terminal state', () => {
    it('uses current screen paints rather than old prompt or approval output', () => {
        const screen = paint([separator, '>', separator, '? for shortcuts  auto · Model · high']);
        expect(readAgyTerminalState(screen)).toMatchObject({ kind: 'prompt', busy: false, mode: 'auto', editor: '' });
        screen.write('\x1b[H\x1b[2Jnew screen');
        expect(readAgyTerminalState(screen).kind).toBe('other');
    });

    it('handles split CSI and OSC sequences and terminal query replies', () => {
        const screen = new AgyTerminalScreen(80, 24);
        screen.write('old\x1b[');
        screen.write('2J\x1b[Hnew\x1b]11;');
        screen.write('?\x07\x1b[6n');
        expect(screen.lines()[0]).toBe('new');
        expect(screen.takeResponses()).toEqual(['\x1b]11;rgb:0000/0000/0000\x07', '\x1b[1;4R']);
    });

    it.each(['Plan mode: research & plan only', 'Auto mode: edits & safe commands auto-approved', 'Accept-edits mode: file edits auto-approved', 'Default mode: ask permission'])('treats the native hint "%s" as a placeholder at an empty cursor', hint => {
        const screen = paint([separator, `> ${hint} (shift+tab to cycle)`, separator, '? for shortcuts  plan · Model · high'], { row: 1, col: 2 });
        expect(readAgyTerminalState(screen)).toMatchObject({ editor: '', mode: 'plan' });
    });

    it('keeps the turn busy while immediate guidance waits for a tool boundary', () => {
        const screen = paint([separator, '>', separator, 'Press up to edit queued messages  auto · Model · high']);
        expect(readAgyTerminalState(screen)).toMatchObject({ kind: 'prompt', busy: true, mode: 'auto' });
    });

    it('recognizes the editor after native hides shortcut hints on paste', () => {
        const screen = paint([separator, '> Run exactly the requested command.', separator, '                                             Gemini 3.8 Flash · low'], { row: 1, col: 35 });
        expect(readAgyTerminalState(screen)).toMatchObject({ kind: 'prompt', editor: 'Run exactly the requested command.', editing: true });
    });

    it('does not let prose mentioning shortcuts or modes become a prompt', () => {
        const screen = paint(['The answer includes esc to cancel and auto · Model', '> quoted user input']);
        expect(readAgyTerminalState(screen).kind).toBe('other');
    });

    it('reads one-time decisions without choosing a native persistent rule', () => {
        const screen = paint(['Command', 'Requesting permission for:', '  echo hello', '', 'Run this command?',
            '> 1. Yes, run command', '  2. Yes, and always allow in this conversation',
            '  3. Yes, and always allow (Persist to settings.json)', '  4. No, cancel', '↑/↓ Navigate · tab Amend', 'esc to cancel']);
        const state = readAgyTerminalState(screen);
        expect(state.kind).toBe('permission');
        expect(state.permission?.target).toBe('echo hello');
        expect(permissionOption(state.permission!, true)).toBe(1);
        expect(permissionOption(state.permission!, false)).toBe(4);
        expect(permissionOption({ ...state.permission!, options: state.permission!.options.slice(1) }, true)).toBeNull();
        const identity = state.permission!.identity;
        screen.write('\x1b[6;1H  \x1b[9;1H>');
        expect(readAgyTerminalState(screen).permission?.identity).toBe(identity);
        expect(readAgyTerminalState(screen).permission?.selected).toBe(4);
    });

    it('restores the primary screen after alternate-screen dialogs and tracks Unicode width', () => {
        const screen = new AgyTerminalScreen(80, 24);
        screen.write('中a\x1b[?1049hlogin\x1b[?1049l');
        expect(screen.lines()[0]).toBe('中a');
        expect(screen.cursor.col).toBe(3);
        expect(screen.alternate).toBe(false);
    });
});
