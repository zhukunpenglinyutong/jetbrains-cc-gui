// @vitest-environment happy-dom

import {renderHook} from '@testing-library/react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {useModelStatePersistence, type UseModelStatePersistenceOptions} from './useModelStatePersistence';

describe('useModelStatePersistence', () => {
    const createOptions = (
        overrides: Partial<UseModelStatePersistenceOptions> = {},
    ): UseModelStatePersistenceOptions => ({
        setCurrentProvider: vi.fn(),
        setSelectedClaudeModel: vi.fn(),
        setSelectedCodexModel: vi.fn(),
        setClaudePermissionMode: vi.fn(),
        setCodexPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        setLongContextEnabled: vi.fn(),
        setReasoningEffort: vi.fn(),
        currentProvider: 'claude',
        selectedClaudeModel: 'claude-sonnet-4-6',
        selectedCodexModel: 'gpt-5.3-codex',
        claudePermissionMode: 'acceptEdits',
        codexPermissionMode: 'default',
        longContextEnabled: true,
        reasoningEffort: 'high',
        ...overrides,
    });

    beforeEach(() => {
        localStorage.clear();
        window.sendToJava = vi.fn();
    });

    it('hydrates local UI preferences without mutating backend session state', () => {
        localStorage.setItem('model-selection-state', JSON.stringify({
            provider: 'codex',
            codexModel: 'gpt-5.3-codex',
            claudeModel: 'claude-sonnet-4-6',
            claudePermissionMode: 'acceptEdits',
            codexPermissionMode: 'plan',
            longContextEnabled: true,
            reasoningEffort: 'high',
        }));

        renderHook(() => useModelStatePersistence(createOptions()));

        const calls = (window.sendToJava as any).mock.calls.map(([payload]: [string]) => payload);
        expect(calls).not.toContainEqual(expect.stringContaining('set_provider:'));
        expect(calls).not.toContainEqual(expect.stringContaining('set_mode:'));
        expect(calls).not.toContainEqual(expect.stringContaining('set_model:'));
    });

    it('preserves codex plan mode during hydration', () => {
        const options = createOptions();
        localStorage.setItem('model-selection-state', JSON.stringify({
            provider: 'codex',
            codexModel: 'gpt-5.3-codex',
            claudeModel: 'claude-sonnet-4-6',
            claudePermissionMode: 'acceptEdits',
            codexPermissionMode: 'plan',
            longContextEnabled: true,
            reasoningEffort: 'high',
        }));

        renderHook(() => useModelStatePersistence(options));

        expect(options.setCodexPermissionMode).toHaveBeenCalledWith('plan');
        expect(options.setPermissionMode).toHaveBeenCalledWith('plan');
    });
});
