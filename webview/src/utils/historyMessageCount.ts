import type { HistorySessionSummary } from '../types';

/** Missing native metadata must remain distinct from a known empty conversation. */
export const isKnownHistoryMessageCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Publish a total only after every listed session has been counted. */
export const sumKnownHistoryMessages = (sessions: readonly HistorySessionSummary[]): number | undefined => {
  let total = 0;
  for (const session of sessions) {
    if (!isKnownHistoryMessageCount(session.messageCount)) return undefined;
    total += session.messageCount;
  }
  return total;
};
