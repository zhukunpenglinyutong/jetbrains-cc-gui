export type StartupHistoryLoadStatus =
  | 'unloaded'
  | 'loading'
  | 'loaded'
  | 'missing'
  | 'timeout'
  | 'cancelled'
  | 'failed';

export interface StartupHistoryLoadState {
  status: StartupHistoryLoadStatus;
  sessionId: string;
  requestId: string;
  generation: number;
  messageCount: number;
  retryable: boolean;
  errorCode?: string;
  message?: string;
}

export function isStartupHistoryLoadState(value: unknown): value is StartupHistoryLoadState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StartupHistoryLoadState>;
  return typeof candidate.sessionId === 'string'
    && typeof candidate.requestId === 'string'
    && typeof candidate.generation === 'number'
    && typeof candidate.messageCount === 'number'
    && typeof candidate.retryable === 'boolean'
    && ['unloaded', 'loading', 'loaded', 'missing', 'timeout', 'cancelled', 'failed'].includes(candidate.status ?? '');
}

/** Discard restore state on a session transition, including transitions through a fresh session. */
export function startupHistoryStateForSession(
  previous: StartupHistoryLoadState | null,
  sessionId: string | null,
): StartupHistoryLoadState | null {
  if (!previous) return null;
  return previous.sessionId === sessionId || (!sessionId && previous.status === 'missing') ? previous : null;
}
