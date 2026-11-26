import { useEffect, useState } from 'react';
import { sendBridgeEvent } from '../utils/bridge';

const BUCKET_IDS = ['gemini-5h', 'gemini-weekly', 'gemini-argon-wtu-weekly', '3p-5h', '3p-weekly'] as const;
// Allow for cold Node discovery and the bounded bridge probe before treating the reply as lost.
const REQUEST_TIMEOUT_MS = 90_000;

type BucketId = typeof BUCKET_IDS[number];

interface GeminiQuotaWindow {
  id: BucketId;
  remainingPercent: number;
  resetsAt?: number;
}

type GeminiQuotaSnapshot =
  | { status: 'ok'; fetchedAt: number; windows: GeminiQuotaWindow[] }
  | { status: 'unavailable'; reasonCode: string; minimumVersion?: string };

const UNAVAILABLE: GeminiQuotaSnapshot = { status: 'unavailable', reasonCode: 'query_failed' };
const pending = new Map<string, (json: string) => void>();
let nextRequestId = 0;

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(new Date(value).getTime());
}

function parseSnapshot(json: string): GeminiQuotaSnapshot {
  const data = JSON.parse(json);
  if (data?.status === 'unavailable' && typeof data.reasonCode === 'string') {
    const minimumVersion = typeof data.minimumVersion === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(data.minimumVersion)
      ? data.minimumVersion : undefined;
    if (data.reasonCode === 'cli_outdated' && !minimumVersion) return UNAVAILABLE;
    return { status: 'unavailable', reasonCode: data.reasonCode, minimumVersion };
  }
  if (data?.status !== 'ok' || !isTimestamp(data.fetchedAt) || !Array.isArray(data.windows)) {
    return UNAVAILABLE;
  }
  const byId = new Map<string, GeminiQuotaWindow>();
  for (const row of data.windows) {
    if (!row || !BUCKET_IDS.includes(row.id) || byId.has(row.id)
      || !Number.isFinite(row.remainingPercent) || row.remainingPercent < 0 || row.remainingPercent > 100) continue;
    byId.set(row.id, {
      id: row.id,
      remainingPercent: row.remainingPercent,
      resetsAt: isTimestamp(row.resetsAt) ? row.resetsAt : undefined,
    });
  }
  const windows = [...byId.values()];
  return windows.length ? { status: 'ok', fetchedAt: data.fetchedAt, windows } : UNAVAILABLE;
}

function receiveQuota(requestId: string, json: string) {
  pending.get(requestId)?.(json);
}

/** Ask for quota only while the Antigravity panel is open. */
export function useGeminiPlanUsage() {
  const [quota, setQuota] = useState<GeminiQuotaSnapshot | null>(null);

  useEffect(() => {
    window.updateGeminiPlanUsage = receiveQuota;
    const id = String(++nextRequestId);
    const finish = (snapshot: GeminiQuotaSnapshot) => {
      if (!pending.delete(id)) return;
      window.clearTimeout(timer);
      setQuota(snapshot);
    };
    const timer = window.setTimeout(() => finish({ status: 'unavailable', reasonCode: 'timeout' }), REQUEST_TIMEOUT_MS);
    pending.set(id, (json) => {
      try {
        finish(parseSnapshot(json));
      } catch {
        finish(UNAVAILABLE);
      }
    });
    if (!sendBridgeEvent('get_gemini_plan_usage', id)) finish(UNAVAILABLE);
    return () => {
      pending.delete(id);
      window.clearTimeout(timer);
    };
  }, []);

  return quota;
}
