import type { ClaudeContentBlock, ClaudeMessage, TodoItem, ToolInput } from '../types';
import { normalizeToolName, TASK_MANAGE_TOOL_NAMES } from './toolConstants';
import { normalizeTodoStatus } from './todoShared';
import type { RawTodoItem } from './todoShared';

function getTodoContent(item: RawTodoItem): string | null {
  const candidates = [item.content, item.step, item.title, item.text];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function normalizeTodoItem(item: RawTodoItem): TodoItem | null {
  const content = getTodoContent(item);
  if (!content) {
    return null;
  }

  const normalized: TodoItem = {
    content,
    status: normalizeTodoStatus(item.status),
  };

  if (typeof item.id === 'string' || typeof item.id === 'number') {
    normalized.id = String(item.id);
  }

  return normalized;
}

export function extractTodosFromToolUse(block: ClaudeContentBlock): TodoItem[] | null {
  if (block.type !== 'tool_use') {
    return null;
  }

  const toolName = normalizeToolName(block.name ?? '');
  const input = (block.input ?? {}) as ToolInput;

  if (toolName === 'todowrite') {
    if (!Array.isArray(input.todos)) {
      return null;
    }
    return input.todos
      .map((item) => (item && typeof item === 'object' ? normalizeTodoItem(item as RawTodoItem) : null))
      .filter((item): item is TodoItem => item !== null);
  }

  if (toolName === 'update_plan') {
    if (!Array.isArray(input.plan)) {
      return null;
    }
    return input.plan
      .map((item) => (item && typeof item === 'object' ? normalizeTodoItem(item as RawTodoItem) : null))
      .filter((item): item is TodoItem => item !== null);
  }

  return null;
}

export function isTaskManageTool(block: ClaudeContentBlock): boolean {
  if (block.type !== 'tool_use') return false;
  return TASK_MANAGE_TOOL_NAMES.has(normalizeToolName(block.name ?? ''));
}

export function extractAccumulatedTasks(
  messages: ClaudeMessage[],
  getContentBlocks: (msg: ClaudeMessage) => ClaudeContentBlock[],
): TodoItem[] {
  const tasks = new Map<string, TodoItem>();
  let nextId = 1;

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const blocks = getContentBlocks(msg);
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      const toolName = normalizeToolName(block.name ?? '');
      const input = (block.input ?? {}) as ToolInput;

      if (toolName === 'taskcreate') {
        const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
        if (!subject) continue;
        const id = String(nextId++);
        tasks.set(id, { id, content: subject, status: 'pending' });
      } else if (toolName === 'taskupdate') {
        const taskId = typeof input.taskId === 'string' ? input.taskId : '';
        if (!taskId || !tasks.has(taskId)) continue;
        const task = tasks.get(taskId)!;
        if (input.status === 'deleted') {
          tasks.delete(taskId);
        } else {
          if (typeof input.status === 'string') {
            task.status = normalizeTodoStatus(input.status);
          }
          if (typeof input.subject === 'string' && input.subject.trim()) {
            task.content = input.subject.trim();
          }
        }
      }
    }
  }

  return Array.from(tasks.values());
}
