export type RawTodoItem = {
  id?: unknown;
  content?: unknown;
  step?: unknown;
  title?: unknown;
  text?: unknown;
  status?: unknown;
  subject?: unknown;
  description?: unknown;
  blockedBy?: unknown;
};

export function normalizeTodoStatus(status: unknown): 'pending' | 'in_progress' | 'completed' {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (value === 'completed' || value === 'done') {
    return 'completed';
  }
  if (value === 'in_progress' || value === 'in-progress' || value === 'active' || value === 'running') {
    return 'in_progress';
  }
  return 'pending';
}
