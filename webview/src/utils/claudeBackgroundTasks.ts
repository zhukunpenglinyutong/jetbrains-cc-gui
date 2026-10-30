/** Native snapshots, independent of foreground results and task_notification edges. */
export interface ClaudeBackgroundTask {
  taskId: string;
  runId?: string;
  description: string;
  taskType: string;
  parentTaskId?: string;
}

interface BackgroundSnapshot {
  sessionId: string | null;
  tasks: readonly ClaudeBackgroundTask[];
}

const EMPTY: BackgroundSnapshot = { sessionId: null, tasks: [] };
let snapshot = EMPTY;
const listeners = new Set<() => void>();

export const getClaudeBackgroundTasks = (): BackgroundSnapshot => snapshot;
export function subscribeClaudeBackgroundTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function replaceSnapshot(next: BackgroundSnapshot): void {
  if (snapshot.sessionId === next.sessionId && JSON.stringify(snapshot.tasks) === JSON.stringify(next.tasks)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function resetClaudeBackgroundTasks(): void {
  replaceSnapshot(EMPTY);
}

/** Invalid/stale input cannot clear running work. An empty native task list can. */
export function receiveClaudeBackgroundTasks(raw: unknown, currentSessionId: string | null): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const event = raw as Record<string, unknown>;
  if (event.subtype !== 'background_tasks_changed') return false;
  if (typeof event.session_id !== 'string' || !event.session_id || !Array.isArray(event.tasks)) return false;
  if (currentSessionId && event.session_id !== currentSessionId) return false;
  const tasks: ClaudeBackgroundTask[] = [];
  const seen = new Set<string>();
  for (const value of event.tasks) {
    if (!value || typeof value !== 'object') return false;
    const task = value as Record<string, unknown>;
    if (typeof task.task_id !== 'string' || !task.task_id || typeof task.task_type !== 'string'
        || typeof task.description !== 'string') return false;
    // Native ambient watchers do not keep the chat busy or need a Stop affordance.
    if (task.ambient === true) continue;
    const runId = typeof task.run_id === 'string' ? task.run_id : undefined;
    const key = JSON.stringify([task.task_id, runId]);
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({ taskId: task.task_id, runId, description: task.description, taskType: task.task_type,
      parentTaskId: typeof task.parent_task_id === 'string' ? task.parent_task_id : undefined });
  }
  replaceSnapshot({ sessionId: event.session_id, tasks });
  return true;
}
