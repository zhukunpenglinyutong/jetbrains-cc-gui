import { renderHook, waitFor } from '@testing-library/react';
import { useModelProviderState } from './useModelProviderState';

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

describe('useModelProviderState', () => {
  const t = ((key: string) => key) as any;

  beforeEach(() => {
    localStorage.clear();
    window.sendToJava = vi.fn();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bootstraps stored model selection without overwriting backend via set_model', async () => {
    const { sendBridgeEvent } = await import('../utils/bridge');
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex',
      claudeModel: 'claude-opus-4-7',
      codexModel: 'gpt-5.4',
      claudePermissionMode: 'bypassPermissions',
      codexPermissionMode: 'default',
      longContextEnabled: true,
    }));

    const { result } = renderHook(() => useModelProviderState({
      addToast: vi.fn(),
      t,
    }));

    await waitFor(() => {
      expect(result.current.currentProvider).toBe('codex');
      expect(result.current.selectedModel).toBe('gpt-5.4');
    });

    expect(sendBridgeEvent).not.toHaveBeenCalledWith('set_provider', expect.anything());
    expect(sendBridgeEvent).not.toHaveBeenCalledWith('set_model', expect.anything());
    await waitFor(() => {
      expect(sendBridgeEvent).toHaveBeenCalledWith('bootstrap_model_selection', JSON.stringify({
        provider: 'codex',
        claudeModel: 'claude-opus-4-7[1m]',
        codexModel: 'gpt-5.4',
      }));
    });
  });
});
