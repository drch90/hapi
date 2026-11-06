import { isObject } from '@hapi/protocol';
import type { AgentMessage } from '@/agent/types';

type ToolCall = Extract<AgentMessage, { type: 'tool_call' }>;

/** Preserve native arguments and real call IDs while supplying HAPI's command,
 * file and search fields. Native Plan artifacts use write_file(Path, Content). */
export function normalizeAgyTool(message: ToolCall): ToolCall {
    const input = message.input;
    if (!isObject(input)) return message;
    if (typeof input.CommandLine === 'string') {
        return { ...message, name: 'Bash', input: { ...input, command: input.CommandLine,
            ...(typeof input.Cwd === 'string' ? { cwd: input.Cwd } : {}) } };
    }
    const path = typeof input.TargetFile === 'string' ? input.TargetFile : typeof input.Path === 'string' ? input.Path : undefined;
    if (path) {
        const content = typeof input.CodeContent === 'string' ? input.CodeContent : typeof input.Content === 'string' ? input.Content : undefined;
        if (content !== undefined && (message.name === 'write_file' || typeof input.CodeContent === 'string')) {
            return { ...message, name: 'Write', input: { ...input, file_path: path, content } };
        }
        if (typeof input.TargetContent === 'string' && typeof input.ReplacementContent === 'string') {
            return { ...message, name: 'Edit', input: { ...input, file_path: path, old_string: input.TargetContent, new_string: input.ReplacementContent } };
        }
    }
    if ((message.kind === 'read' || message.name === 'view_file' || message.name === 'read_file') && typeof input.AbsolutePath === 'string') {
        return { ...message, name: 'Read', input: { ...input, file_path: input.AbsolutePath,
            ...(typeof input.StartLine === 'number' ? { offset: input.StartLine } : {}),
            ...(typeof input.StartLine === 'number' && typeof input.EndLine === 'number'
                ? { limit: input.EndLine - input.StartLine + 1 } : {}) } };
    }
    if (typeof input.Query === 'string' && typeof input.SearchPath === 'string') {
        return { ...message, name: 'Grep', input: { ...input, pattern: input.Query, path: input.SearchPath } };
    }
    if (typeof input.DirectoryPath === 'string') {
        return { ...message, name: 'LS', input: { ...input, path: input.DirectoryPath } };
    }
    return message;
}
