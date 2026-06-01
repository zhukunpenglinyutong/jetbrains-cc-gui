export interface StreamScopeState {
  content: string;
  thinking: string;
  messageIndex: number;
  isStreaming: boolean;
  backendRendering: boolean;
  pendingUpdateJson: string | null;
  pendingUpdateSequence: number | null;
  pendingUpdateRaf: number | null;
  lastActivityAt: number;
  minAcceptedSequence: number;
}

const streamScopeStates = new Map<string, StreamScopeState>();

const normalizeScopeKey = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizePart = (value: string | null | undefined): string => {
  if (typeof value !== 'string') {
    return 'default';
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'default';
};

export const getStreamScopeKey = (
  provider: string,
  tabId: string | null | undefined,
  turnId: number,
): string => `${normalizePart(provider)}:${normalizePart(tabId)}:${turnId}`;

export const getActiveStreamScopeKey = (): string | null => normalizeScopeKey(window.__activeStreamScopeKey);

export const setActiveStreamScopeKey = (scopeKey: string | null | undefined): void => {
  window.__activeStreamScopeKey = normalizeScopeKey(scopeKey);
};

export const getOrCreateStreamScopeState = (scopeKey: string): StreamScopeState => {
  const existing = streamScopeStates.get(scopeKey);
  if (existing) {
    return existing;
  }
  const state: StreamScopeState = {
    content: '',
    thinking: '',
    messageIndex: -1,
    isStreaming: false,
    backendRendering: false,
    pendingUpdateJson: null,
    pendingUpdateSequence: null,
    pendingUpdateRaf: null,
    lastActivityAt: 0,
    minAcceptedSequence: 0,
  };
  streamScopeStates.set(scopeKey, state);
  return state;
};

export const getStreamScopeState = (scopeKey: string | null | undefined): StreamScopeState | null => {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  if (!normalizedScopeKey) {
    return null;
  }
  return streamScopeStates.get(normalizedScopeKey) ?? null;
};

export const getOrCreateActiveStreamScopeState = (): StreamScopeState | null => {
  const scopeKey = getActiveStreamScopeKey();
  if (!scopeKey) {
    return null;
  }
  return getOrCreateStreamScopeState(scopeKey);
};

export const clearStreamScopeState = (scopeKey: string | null | undefined): void => {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  if (!normalizedScopeKey) {
    return;
  }
  const state = streamScopeStates.get(normalizedScopeKey);
  if (state?.pendingUpdateRaf != null) {
    cancelAnimationFrame(state.pendingUpdateRaf);
  }
  streamScopeStates.delete(normalizedScopeKey);
  if (getActiveStreamScopeKey() === normalizedScopeKey) {
    window.__activeStreamScopeKey = null;
  }
};

export const clearStreamScopesForTab = (provider: string, tabId: string | null | undefined): void => {
  const prefix = `${normalizePart(provider)}:${normalizePart(tabId)}:`;
  for (const key of [...streamScopeStates.keys()]) {
    if (key.startsWith(prefix)) {
      clearStreamScopeState(key);
    }
  }
};

export const cancelScopedPendingUpdate = (scopeKey: string | null | undefined): void => {
  const state = getStreamScopeState(scopeKey);
  if (!state) {
    return;
  }
  if (state.pendingUpdateRaf != null) {
    cancelAnimationFrame(state.pendingUpdateRaf);
  }
  state.pendingUpdateRaf = null;
  state.pendingUpdateJson = null;
  state.pendingUpdateSequence = null;
};

export const queueScopedPendingUpdate = (
  scopeKey: string | null | undefined,
  json: string,
  sequence: number | null,
): void => {
  const state = getStreamScopeState(scopeKey);
  if (!state) {
    return;
  }
  state.pendingUpdateJson = json;
  state.pendingUpdateSequence = sequence;
  state.lastActivityAt = Date.now();
};

export const consumeScopedPendingUpdate = (
  scopeKey: string | null | undefined,
): { json: string | null; sequence: number | null } => {
  const state = getStreamScopeState(scopeKey);
  if (!state) {
    return { json: null, sequence: null };
  }
  const result = {
    json: state.pendingUpdateJson,
    sequence: state.pendingUpdateSequence,
  };
  state.pendingUpdateJson = null;
  state.pendingUpdateSequence = null;
  return result;
};

export const markScopeActivity = (scopeKey: string | null | undefined): void => {
  const state = getStreamScopeState(scopeKey);
  if (state) {
    state.lastActivityAt = Date.now();
  }
};

export const getScopeLastActivityAt = (scopeKey: string | null | undefined): number => {
  const state = getStreamScopeState(scopeKey);
  return state?.lastActivityAt ?? 0;
};
