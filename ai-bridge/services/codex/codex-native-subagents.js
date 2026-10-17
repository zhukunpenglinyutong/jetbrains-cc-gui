import { readNativeHistoryPage } from './codex-native-history.js';

/** Verifies ancestry before reading a child; parent completion proves nothing about its child. */
export async function readNativeSubagent(read, { rootThreadId, agentId, includeHistory = false, nativeTaskPreviousTurnId } = {}) {
  if (!rootThreadId || !agentId || rootThreadId === agentId) throw new Error('A subagent requires distinct root and child ids');
  let child;
  let ancestorId = agentId;
  const seen = new Set([rootThreadId]);
  while (ancestorId !== rootThreadId) {
    if (seen.has(ancestorId) || seen.size > 32) throw new Error('Native subagent ancestry is cyclic or too deep');
    seen.add(ancestorId);
    const metadata = await read('thread/read', { threadId: ancestorId, includeTurns: false });
    if (metadata.thread?.id !== ancestorId) throw new Error('Native subagent returned a different thread');
    child ??= metadata.thread;
    ancestorId = metadata.thread.parentThreadId;
    if (!ancestorId) throw new Error('Native subagent does not belong to the requested root');
  }
  let page = await readNativeHistoryPage(read, { threadId: agentId, limit: includeHistory ? 30 : 1 });
  const latestTurnStatus = page.latestTurnStatus;
  const latestTurnId = page.latestTurnId;
  // TriggerTurn acknowledges queueing before its consumer starts an idle child's next turn.
  const waitingForFollowup = nativeTaskPreviousTurnId === latestTurnId
    && ['completed', 'failed', 'interrupted'].includes(latestTurnStatus);
  const pages = includeHistory && !waitingForFollowup ? [page.messages] : [];
  const cursors = new Set();
  while (includeHistory && !waitingForFollowup && page.cursor != null) {
    if (cursors.has(page.cursor)) throw new Error('Native subagent repeated its history cursor');
    cursors.add(page.cursor);
    if (cursors.size > 100) throw new Error('Native subagent history exceeded the display page limit');
    page = await readNativeHistoryPage(read, { threadId: agentId, cursor: page.cursor, limit: 30, readMode: page.readMode });
    pages.unshift(page.messages);
  }
  const positions = new Map();
  const messages = [];
  for (const message of pages.flat()) {
    const key = message.raw?.uuid;
    if (!key || !positions.has(key)) {
      if (key) positions.set(key, messages.length);
      messages.push(message);
    } else messages[positions.get(key)] = message;
  }
  const nativeStatus = child.status?.type ?? child.status;
  let status = 'running';
  let completed = false;
  if (nativeStatus === 'systemError' || (!waitingForFollowup && nativeStatus !== 'active' && ['failed', 'interrupted'].includes(latestTurnStatus))) status = 'error';
  else if (!waitingForFollowup && nativeStatus !== 'active' && latestTurnStatus === 'completed') {
    status = 'completed';
    completed = true;
  }
  return { success: true, agentId, parentThreadId: child.parentThreadId, status, completed,
    nativeStatus: nativeStatus ?? 'unknown', latestTurnStatus, latestTurnId,
    ...(nativeTaskPreviousTurnId ? { nativeTaskPreviousTurnId:
      !latestTurnId || nativeTaskPreviousTurnId === latestTurnId ? nativeTaskPreviousTurnId : null } : {}),
    ...(includeHistory ? { messages } : {}) };
}
