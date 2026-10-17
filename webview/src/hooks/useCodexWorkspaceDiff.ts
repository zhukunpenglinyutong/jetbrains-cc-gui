import { useCallback, useEffect, useState } from 'react';
import { sendToJava } from '../utils/bridge';
import type { CodexWorkspaceDiffResult } from '../utils/workspaceDiffFiles';

interface WorkspaceDiffState {
  open: boolean;
  result: CodexWorkspaceDiffResult | null;
}

/**
 * Receives `codex-workspace-diff` snapshots pushed by the Java handler and
 * opens the dialog for every fresh result. A missing reply is surfaced by the
 * sender's bridge-unavailable toast, so this hook only handles success data.
 */
export function useCodexWorkspaceDiff(): WorkspaceDiffState & { close: () => void; refresh: () => void } {
  const [state, setState] = useState<WorkspaceDiffState>({ open: false, result: null });

  useEffect(() => {
    const onDiff = (event: Event) => {
      const detail = (event as CustomEvent<CodexWorkspaceDiffResult>).detail;
      if (!detail || typeof detail !== 'object') return;
      setState({ open: true, result: detail });
    };
    window.addEventListener('codex-workspace-diff', onDiff);
    return () => window.removeEventListener('codex-workspace-diff', onDiff);
  }, []);

  const close = useCallback(() => {
    setState((previous) => ({ ...previous, open: false }));
  }, []);

  const refresh = useCallback(() => {
    sendToJava('codex_read_workspace_diff', {});
  }, []);

  return { ...state, close, refresh };
}

export default useCodexWorkspaceDiff;
