import { describe, expect, it } from 'vitest';
import { normalizeAgyTool } from './messages';

describe('Antigravity native tool presentation', () => {
    it.each([
        [{ CommandLine: 'git status', Cwd: '/repo' }, 'execute', 'Bash', { command: 'git status', cwd: '/repo' }],
        [{ AbsolutePath: '/repo/file', StartLine: 10, EndLine: 20 }, 'read', 'Read', { file_path: '/repo/file', offset: 10, limit: 11 }],
        [{ TargetFile: '/repo/file', CodeContent: 'new' }, 'edit', 'Write', { file_path: '/repo/file', content: 'new' }],
        [{ TargetFile: '/repo/file', TargetContent: 'old', ReplacementContent: 'new' }, 'edit', 'Edit', { old_string: 'old', new_string: 'new' }],
        [{ Query: 'TODO', SearchPath: '/repo' }, 'search', 'Grep', { pattern: 'TODO', path: '/repo' }],
        [{ DirectoryPath: '/repo' }, 'read', 'LS', { path: '/repo' }],
    ] as const)('normalizes native arguments for %s', (input, kind, name, expected) => {
        expect(normalizeAgyTool({ type: 'tool_call', id: 'call', name: 'native prose title', kind, status: 'in_progress', input }))
            .toMatchObject({ id: 'call', name, input: expected, status: 'in_progress' });
    });

    it('renders native Plan artifacts as file writes while retaining their feedback metadata', () => {
        const artifact = { RequestFeedback: true, UserFacing: true };
        expect(normalizeAgyTool({ type: 'tool_call', id: 'native-plan-call', name: 'write_file', status: 'in_progress',
            input: { Path: '/brain/plan.md', Content: '# Plan', ArtifactMetadata: artifact } }))
            .toMatchObject({ id: 'native-plan-call', name: 'Write', input: { file_path: '/brain/plan.md', content: '# Plan', ArtifactMetadata: artifact } });
    });
});
