/** A bounded VT screen for agy's native TUI. Decisions use the current screen,
 * not text that a previous paint left in the output stream. */
export class AgyTerminalScreen {
    private cells: string[][];
    private primary: string[][] | null = null;
    private row = 0;
    private col = 0;
    private saved = { row: 0, col: 0 };
    private scrollTop = 0;
    private scrollBottom: number;
    private pending = '';
    private responses: string[] = [];
    private wrap = false;
    revision = 0;

    constructor(public cols = 160, public rows = 48) {
        this.cells = this.blankScreen();
        this.scrollBottom = rows - 1;
    }

    private blankLine(): string[] { return Array<string>(this.cols).fill(' '); }
    private blankScreen(): string[][] { return Array.from({ length: this.rows }, () => this.blankLine()); }
    get alternate(): boolean { return this.primary !== null; }
    get cursor(): { row: number; col: number } { return { row: this.row, col: this.col }; }
    lines(): string[] { return this.cells.map(line => line.join('').trimEnd()); }
    takeResponses(): string[] { return this.responses.splice(0); }

    resize(cols: number, rows: number): void {
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 10 || rows > 300) return;
        const resize = (screen: string[][]) => Array.from({ length: rows }, (_, row) =>
            Array.from({ length: cols }, (_, col) => screen[row]?.[col] ?? ' '));
        this.cells = resize(this.cells);
        if (this.primary) this.primary = resize(this.primary);
        this.cols = cols;
        this.rows = rows;
        this.scrollTop = 0;
        this.scrollBottom = rows - 1;
        this.move(this.row, this.col);
        this.revision++;
    }

    private move(row: number, col: number): void {
        this.row = Math.min(this.rows - 1, Math.max(0, row));
        this.col = Math.min(this.cols - 1, Math.max(0, col));
        this.wrap = false;
    }

    private scroll(count: number): void {
        const amount = Math.min(Math.abs(count), this.scrollBottom - this.scrollTop + 1);
        for (let i = 0; i < amount; i++) {
            if (count > 0) {
                this.cells.splice(this.scrollTop, 1);
                this.cells.splice(this.scrollBottom, 0, this.blankLine());
            } else {
                this.cells.splice(this.scrollBottom, 1);
                this.cells.splice(this.scrollTop, 0, this.blankLine());
            }
        }
    }

    private newline(): void {
        if (this.row === this.scrollBottom) this.scroll(1);
        else this.row = Math.min(this.rows - 1, this.row + 1);
        this.wrap = false;
    }

    private put(char: string): void {
        const width = displayWidth(char);
        if (width === 0) {
            const col = Math.max(0, this.col - 1);
            this.cells[this.row]![col] += char;
            return;
        }
        if (this.wrap || this.col + width > this.cols) { this.col = 0; this.newline(); }
        this.cells[this.row]![this.col] = char;
        if (width === 2) this.cells[this.row]![this.col + 1] = '';
        this.col += width;
        if (this.col >= this.cols) { this.col = this.cols - 1; this.wrap = true; }
    }

    write(data: string): void {
        const input = this.pending + data;
        this.pending = '';
        let offset = 0;
        while (offset < input.length) {
            const char = input[offset]!;
            if (char === '\x1b') {
                const start = offset;
                const kind = input[++offset];
                if (!kind) { this.pending = input.slice(start); break; }
                if (kind === '[') {
                    const end = input.slice(offset + 1).search(/[@-~]/);
                    if (end < 0) { this.pending = input.slice(start); break; }
                    const finish = offset + 1 + end;
                    this.csi(input.slice(offset + 1, finish), input[finish]!);
                    offset = finish + 1;
                    continue;
                }
                if (kind === ']' || kind === 'P' || kind === '^' || kind === '_') {
                    const tail = input.slice(offset + 1);
                    const end = tail.search(/\x07|\x1b\\/);
                    if (end < 0) { this.pending = input.slice(start); break; }
                    const value = tail.slice(0, end);
                    if (kind === ']' && value === '11;?') this.responses.push('\x1b]11;rgb:0000/0000/0000\x07');
                    if (kind === ']' && value === '10;?') this.responses.push('\x1b]10;rgb:ffff/ffff/ffff\x07');
                    offset += 1 + end + (tail[end] === '\x07' ? 1 : 2);
                    continue;
                }
                if ('()*+'.includes(kind)) {
                    if (offset + 1 >= input.length) { this.pending = input.slice(start); break; }
                    offset += 2;
                    continue;
                }
                if (kind === '7') this.saved = this.cursor;
                if (kind === '8') this.move(this.saved.row, this.saved.col);
                if (kind === 'D') this.newline();
                if (kind === 'M') {
                    if (this.row === this.scrollTop) this.scroll(-1);
                    else this.move(this.row - 1, this.col);
                }
                if (kind === 'c') { this.cells = this.blankScreen(); this.move(0, 0); }
                offset++;
                continue;
            }
            offset++;
            if (char === '\r') { this.col = 0; this.wrap = false; }
            else if (char === '\n' || char === '\v' || char === '\f') this.newline();
            else if (char === '\b') this.move(this.row, this.col - 1);
            else if (char === '\t') this.move(this.row, (Math.floor(this.col / 8) + 1) * 8);
            else if (char >= ' ' && char !== '\x7f') {
                const point = input.codePointAt(offset - 1)!;
                const text = String.fromCodePoint(point);
                if (point > 0xffff) offset++;
                this.put(text);
            }
        }
        // An unterminated control string must not retain unbounded agent output.
        if (this.pending.length > 65_536) { this.pending = ''; this.cells = this.blankScreen(); }
        this.revision++;
    }

    private csi(raw: string, command: string): void {
        const prefix = raw.match(/^[?><=]/)?.[0] ?? '';
        const values = raw.replace(/^[?><=]/, '').split(';').map(value => Number.parseInt(value, 10) || 0);
        const n = values[0] || 1;
        if (command === 'A') this.move(this.row - n, this.col);
        else if (command === 'B' || command === 'e') this.move(this.row + n, this.col);
        else if (command === 'C' || command === 'a') this.move(this.row, this.col + n);
        else if (command === 'D') this.move(this.row, this.col - n);
        else if (command === 'E') this.move(this.row + n, 0);
        else if (command === 'F') this.move(this.row - n, 0);
        else if (command === 'G' || command === '`') this.move(this.row, n - 1);
        else if (command === 'd') this.move(n - 1, this.col);
        else if (command === 'H' || command === 'f') this.move(n - 1, (values[1] || 1) - 1);
        else if (command === 'J') {
            const mode = values[0] ?? 0;
            if (mode === 2 || mode === 3) this.cells = this.blankScreen();
            else if (mode === 0) {
                this.cells[this.row]!.fill(' ', this.col);
                for (let i = this.row + 1; i < this.rows; i++) this.cells[i] = this.blankLine();
            } else if (mode === 1) {
                for (let i = 0; i < this.row; i++) this.cells[i] = this.blankLine();
                this.cells[this.row]!.fill(' ', 0, this.col + 1);
            }
        } else if (command === 'K') {
            const mode = values[0] ?? 0;
            this.cells[this.row]!.fill(' ', mode === 0 ? this.col : 0, mode === 1 ? this.col + 1 : this.cols);
        } else if (command === 'P') {
            this.cells[this.row]!.splice(this.col, Math.min(n, this.cols - this.col));
            while (this.cells[this.row]!.length < this.cols) this.cells[this.row]!.push(' ');
        } else if (command === '@') {
            this.cells[this.row]!.splice(this.col, 0, ...Array<string>(Math.min(n, this.cols)).fill(' '));
            this.cells[this.row]!.length = this.cols;
        } else if (command === 'X') this.cells[this.row]!.fill(' ', this.col, Math.min(this.cols, this.col + n));
        else if (command === 'L' || command === 'M') {
            if (this.row < this.scrollTop || this.row > this.scrollBottom) return;
            for (let i = 0; i < Math.min(n, this.scrollBottom - this.row + 1); i++) {
                if (command === 'L') { this.cells.splice(this.scrollBottom, 1); this.cells.splice(this.row, 0, this.blankLine()); }
                else { this.cells.splice(this.row, 1); this.cells.splice(this.scrollBottom, 0, this.blankLine()); }
            }
        } else if (command === 'S') this.scroll(n);
        else if (command === 'T') this.scroll(-n);
        else if (command === 'r' && !prefix) {
            this.scrollTop = Math.min(this.rows - 1, Math.max(0, (values[0] || 1) - 1));
            this.scrollBottom = Math.max(this.scrollTop, Math.min(this.rows - 1, (values[1] || this.rows) - 1));
            this.move(0, 0);
        } else if (command === 's') this.saved = this.cursor;
        else if (command === 'u' && !prefix) this.move(this.saved.row, this.saved.col);
        else if ((command === 'h' || command === 'l') && prefix === '?' && values.some(value => value === 1049 || value === 1047)) {
            if (command === 'h' && !this.primary) { this.primary = this.cells; this.saved = this.cursor; this.cells = this.blankScreen(); this.move(0, 0); }
            if (command === 'l' && this.primary) { this.cells = this.primary; this.primary = null; this.move(this.saved.row, this.saved.col); }
        } else if (command === 'n' && values[0] === 6) this.responses.push(`\x1b[${this.row + 1};${this.col + 1}R`);
        else if (command === 'c') this.responses.push(prefix === '>' ? '\x1b[>0;0;0c' : '\x1b[?1;2c');
        else if (command === 'u' && prefix === '?') this.responses.push('\x1b[?0u');
    }
}

function displayWidth(text: string): number {
    if (typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function') return Bun.stringWidth(text);
    if (/\p{Mark}/u.test(text) || text === '\u200d' || text === '\ufe0f') return 0;
    const code = text.codePointAt(0)!;
    return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf
        || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff
        || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff00 && code <= 0xff60
        || code >= 0x1f300) ? 2 : 1;
}

export type AgyNativeMode = 'default' | 'accept-edits' | 'auto' | 'plan';

export type AgyTerminalState = {
    kind: 'prompt' | 'permission' | 'trust' | 'login' | 'other';
    busy: boolean;
    mode: AgyNativeMode | null;
    editor: string | null;
    footer: string | null;
    lines: string[];
    /** Native hides the left footer hints while the editor contains text. */
    editing?: boolean;
    permission?: AgyTerminalPermission;
};

export type AgyTerminalPermission = {
    target: string;
    question: string;
    options: Array<{ index: number; text: string }>;
    selected: number;
    identity: string;
};

function readPermission(lines: string[]): AgyTerminalPermission | undefined {
    let start = lines.length - 1;
    while (start >= 0 && !/^\s*Requesting permission for:\s*$/.test(lines[start]!)) start--;
    if (start < 0 || !lines.some(line => /↑\/↓.*Navigate/.test(line))) return;
    const first = lines.findIndex((line, index) => index > start && /^\s*>?\s*1\. /.test(line));
    if (first < 0) return;
    const header = lines.slice(start + 1, first).map(line => line.trim()).filter(Boolean);
    const question = header.pop();
    if (!question?.endsWith('?')) return;
    const options: AgyTerminalPermission['options'] = [];
    let selected = -1;
    for (const line of lines.slice(first)) {
        if (/↑\/↓.*Navigate|^esc to cancel/.test(line)) break;
        const match = line.match(/^\s*(>)?\s*(\d+)\. (.+)$/);
        if (match) {
            const index = Number(match[2]);
            if (match[1]) selected = index;
            options.push({ index, text: match[3]! });
        } else if (line.trim() && options.length) options[options.length - 1]!.text += ` ${line.trim()}`;
    }
    if (selected < 0 || options.length < 2 || !options.some(option => /^No\b|^Cancel\b|^Deny\b/.test(option.text))) return;
    const target = header.join(' ').trim();
    if (!target) return;
    return { target, question, options, selected, identity: JSON.stringify([target, question, options]) };
}

export function readAgyTerminalState(screen: AgyTerminalScreen): AgyTerminalState {
    const lines = screen.lines();
    const text = lines.join('\n');
    const base = { busy: false, mode: null, editor: null, footer: null, lines };
    if (text.includes('Do you trust the contents of this project?')
        && lines.some(line => /^\s*> Yes, I trust this folder\s*$/.test(line))
        && lines.some(line => /^\s*No, exit\s*$/.test(line))) return { ...base, kind: 'trust' };
    const permission = readPermission(lines);
    if (permission) return { ...base, kind: 'permission', busy: true, permission };
    if (screen.alternate) return { ...base, kind: /Signing in|Select login method|not signed in/.test(text) ? 'login' : 'other' };
    for (let i = lines.length - 1; i >= 2; i--) {
        const footer = lines[i]!;
        const hints = /^(?:\? for shortcuts|esc to cancel|press ctrl\+d again to exit|Press up to edit queued messages)/.test(footer);
        if (!hints && !/^\s{2,}\S/.test(footer)) continue;
        if (!/^─{10,}\s*$/.test(lines[i - 1]!)) continue;
        let top = i - 2;
        while (top >= 0 && !/^─{10,}\s*$/.test(lines[top]!)) top--;
        if (top < 0 || !/^>/.test(lines[top + 1] ?? '')) continue;
        const nativeMode = footer.match(/\b(accept-edits|auto|plan)\s*·/)?.[1] as AgyNativeMode | undefined;
        let editor = lines.slice(top + 1, i - 1).map((line, index) => index === 0 ? line.replace(/^> ?/, '') : line.replace(/^  /, '')).join('\n').trimEnd();
        if (!hints && (!editor || screen.cursor.row <= top || screen.cursor.row >= i - 1)) continue;
        // A mode-change hint is painted as an editor placeholder. Its cursor
        // stays at the empty input position; it is not text waiting to be sent.
        if (screen.cursor.row === top + 1 && screen.cursor.col === 2
            && /^(?:Plan mode:|Auto mode:|Accept-edits mode:|Default mode:)/.test(editor)
            && editor.includes('shift+tab to cycle')) editor = '';
        return { kind: 'prompt', busy: /^(?:esc to cancel|Press up to edit queued messages)/.test(footer), mode: nativeMode ?? 'default',
            editor, ...(!hints ? { editing: true } : {}),
            footer, lines };
    }
    return { ...base, kind: /Signing in|Select login method/.test(text) ? 'login' : 'other' };
}
