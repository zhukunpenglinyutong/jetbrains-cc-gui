import { useEffect, useState } from 'react';
import type { HistoryData } from '../types';
import { useSession } from '../contexts/SessionContext';
import { sendBridgeEvent } from '../utils/bridge';
import { waitForBridge } from '../utils/bridgeStartup';

/**
 * Backoff ladder (ms) for the history-metadata bootstrap described below.
 *
 * Attempt 0 fires immediately and normally succeeds: a session restored at tool
 * window start is already on disk and already in the backend's session index,
 * so the very first read describes it. The later attempts only exist for the
 * other case — a session whose id the SDK reported moments ago, before its
 * jsonl reached the index. They are cheap rather than free, but the first
 * attempt has already warmed `SessionIndexCache` / `SessionIndexManager`, so
 * every retry is served from that cache instead of re-scanning the project.
 */
const RETRY_DELAYS_MS = [0, 1200, 4000];

/**
 * localStorage key holding the cross-slice provider snapshot. Mirrors
 * useModelStatePersistence, which writes it on every provider switch.
 */
const PROVIDER_STORAGE_KEY = 'model-selection-state';

/**
 * Best-effort provider of the active session, used only to decide whether a
 * bootstrap read is worth doing at all.
 *
 * Per-tab restore wins over the global snapshot for the same reason
 * useModelStatePersistence applies it: `__INITIAL_TAB_PROVIDER__` is what the
 * backend restored for THIS tab, while the localStorage copy is shared by every
 * tab in the JCEF process. A stale read here is harmless — it can only cost a
 * wasted history load for a Codex session that could not have shown the hint
 * anyway.
 */
const resolveProviderHint = (): string => {
  const tabProvider = typeof window.__INITIAL_TAB_PROVIDER__ === 'string'
    ? window.__INITIAL_TAB_PROVIDER__.trim()
    : '';
  if (tabProvider) {
    return tabProvider;
  }
  try {
    const raw = localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { provider?: unknown };
      if (typeof parsed.provider === 'string' && parsed.provider.trim()) {
        return parsed.provider.trim();
      }
    }
  } catch {
    // Corrupt or unreadable snapshot: fall through to the backend default.
  }
  return 'claude';
};

/**
 * Ensures the history snapshot describes the active session, without requiring
 * a manual visit to the history view.
 *
 * The header's convert hint is derived from `historyData.sessions`, and that
 * snapshot is otherwise only populated when the user opens the history view —
 * so on a fresh tool window the hint never renders, even though its primary
 * audience (a session the SDK just created) is exactly the case where the user
 * has not been to history yet.
 *
 * This asks the backend for the same project history the history view itself
 * requests (`load_history_data`, the cached read path — not
 * `deep_search_history`, which drops the index and rescans everything). Three
 * properties keep it from being a startup tax:
 *
 *  - it only runs while the hint could actually be shown (chat view + a live
 *    session), never on mount;
 *  - it stops the moment the snapshot already answers, so after one real visit
 *    to the history view it does no work at all;
 *  - it is capped at {@link RETRY_DELAYS_MS}.length reads per session, and the
 *    first one warms the backend cache the retries read from.
 *
 * A side benefit: the snapshot is warm by the time the user does open the
 * history view, which issues the identical request anyway.
 */
export function useActiveSessionEntrypoint(enabled: boolean): void {
  const { currentSessionId, historyData } = useSession();
  const sessions: HistoryData['sessions'] | undefined = historyData?.sessions;

  // The snapshot answering is the stop condition, and it must distinguish
  // "session absent" from "session present but with no entrypoint": the second
  // is a complete answer (no hint) and must not keep the ladder running.
  const snapshotCoversSession = Boolean(
    currentSessionId
    && sessions?.some(session => session.sessionId === currentSessionId)
  );

  // Number of reads already issued for this session id, held in state (not a
  // ref) so each advance re-runs the effect below. Keying by id instead of
  // resetting in an effect avoids one render where a new session would inherit
  // the previous session's exhausted budget.
  const [progress, setProgress] = useState<{ sessionId: string; issued: number } | null>(null);
  const issued = progress?.sessionId === currentSessionId ? progress.issued : 0;

  useEffect(() => {
    if (!enabled || !currentSessionId || snapshotCoversSession) {
      return;
    }
    if (issued >= RETRY_DELAYS_MS.length) {
      return;
    }

    // Only Claude sessions can carry a convertible entrypoint: the backend
    // conversion service rewrites files under `~/.claude/projects`, so no
    // other provider could produce `sdk-cli` / `claude-vscode`. Skipping them
    // keeps a Codex user from paying for a read that cannot change the hint.
    // Read imperatively rather than as a dep — a stale provider only costs a
    // wasted load, and subscribing to it would re-run the ladder on switches.
    if (resolveProviderHint() !== 'claude') {
      return;
    }

    let cancelled = false;
    const cancelBridgeWait = waitForBridge(() => {
      if (!cancelled) {
        sendBridgeEvent('load_history_data', 'claude');
      }
    });

    // Schedule the next step from every attempt, including the immediate one —
    // otherwise the ladder would never leave step 0. If the effect re-runs in
    // between (provider or view change), cleanup drops this timer and the rerun
    // re-issues the read instead, so a lost ladder self-heals.
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        setProgress({ sessionId: currentSessionId, issued: issued + 1 });
      }
    }, RETRY_DELAYS_MS[issued]);

    return () => {
      cancelled = true;
      cancelBridgeWait();
      window.clearTimeout(timer);
    };
  }, [enabled, currentSessionId, snapshotCoversSession, issued]);
}
