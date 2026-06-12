import type { ClaudeContentBlock, ClaudeMessage, TodoItem, ToolInput } from '../types';
import { normalizeToolName, TASK_MANAGE_TOOL_NAMES } from './toolConstants';
import { normalizeTodoStatus } from './todoShared';
import type { RawTodoItem } from './todoShared';

function getTodoContent(item: RawTodoItem): string | null {
  const candidates = [item.content, item.step, item.title, item.text, item.subject, item.description];
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

  // Preserve blockedBy if present in the raw item
  if (Array.isArray(item.blockedBy)) {
    normalized.blockedBy = item.blockedBy
      .map((id: unknown) => (typeof id === 'string' || typeof id === 'number' ? String(id) : null))
      .filter((id): id is string => id !== null);
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

/**
 * Extract accumulated tasks from TaskCreate/TaskUpdate tool calls (new structured Task API).
 *
 * Task ID resolution: TaskCreate input does not contain the real task ID — it is only
 * available in the tool_result user message (toolUseResult.task.id). This function makes
 * a single pass over the messages: user messages build a tool_use_id → real taskId map,
 * assistant messages buffer their TaskCreate/TaskUpdate blocks. The buffered blocks are
 * then processed in document order once the full id map is known. Sessions without any
 * task tools short-circuit before allocating the task map.
 */
export function extractAccumulatedTasks(
  messages: ClaudeMessage[],
  getContentBlocks: (msg: ClaudeMessage) => ClaudeContentBlock[]
): TodoItem[] {
  const toolUseToTaskId = new Map<string, string>();
  const pendingTaskBlocks: ClaudeContentBlock[] = [];

  for (const msg of messages) {
    if (msg.type === 'user') {
      const raw = msg.raw;
      if (!raw || typeof raw === 'string') continue;
      const rawObj = raw as Record<string, unknown>;

      // Find tool_result blocks in raw content (handles raw.content and raw.message.content)
      const rawContent = rawObj.message
        ? (rawObj.message as Record<string, unknown>).content
        : rawObj.content;
      if (!Array.isArray(rawContent)) continue;

      const toolResultBlocks = rawContent.filter(
        (b): b is Record<string, unknown> =>
          Boolean(b) && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result'
      );
      // The message-level toolUseResult.task.id can only be reliably attributed to a
      // tool_use when this message carries exactly one tool_result. With parallel tool
      // calls (several tool_results sharing one message-level toolUseResult), applying it
      // to every block would mis-map task IDs and silently drop tasks via key collisions,
      // so fall back to per-block content parsing in that case.
      const singleResult = toolResultBlocks.length === 1;

      for (const block of toolResultBlocks) {
        const toolUseId = block.tool_use_id;
        if (typeof toolUseId !== 'string' || toolUseToTaskId.has(toolUseId)) continue;

        // Strategy 1: read from raw.toolUseResult.task.id (only when unambiguous)
        if (singleResult) {
          const tur = rawObj.toolUseResult;
          if (tur && typeof tur === 'object' && !Array.isArray(tur)) {
            const task = (tur as Record<string, unknown>).task;
            if (task && typeof task === 'object' && !Array.isArray(task)) {
              const tid = (task as Record<string, unknown>).id;
              if (typeof tid === 'string' || typeof tid === 'number') {
                toolUseToTaskId.set(toolUseId, String(tid));
                continue;
              }
            }
          }
        }

        // Strategy 2: parse from tool_result block content (e.g., "Task #1 created successfully")
        // Stricter regex avoids false matches with PR numbers or other #digits.
        const content = typeof block.content === 'string' ? block.content : '';
        const match = /\btask\s*#(\d+)/i.exec(content);
        if (match) {
          toolUseToTaskId.set(toolUseId, match[1]);
        }
      }
    } else if (msg.type === 'assistant') {
      for (const block of getContentBlocks(msg)) {
        if (block.type !== 'tool_use') continue;
        const toolName = normalizeToolName(block.name ?? '');
        if (toolName === 'taskcreate' || toolName === 'taskupdate') {
          pendingTaskBlocks.push(block);
        }
      }
    }
  }

  if (pendingTaskBlocks.length === 0) return [];

  // Process buffered TaskCreate / TaskUpdate in document order using the resolved IDs.
  const taskMap = new Map<string, TodoItem>();
  for (const block of pendingTaskBlocks) {
    if (block.type !== 'tool_use') continue;
    const toolName = normalizeToolName(block.name ?? '');
    const input = (block.input ?? {}) as ToolInput;

    if (toolName === 'taskcreate') {
      const subject = input.subject;
      const description = input.description;
      // Resolve the real task ID from the corresponding tool_result, fall back to block.id
      const realTaskId = toolUseToTaskId.get(block.id ?? '');
      const taskId = realTaskId ?? block.id;

      if (typeof subject === 'string' && subject.trim() && taskId) {
        const content = description && typeof description === 'string'
          ? `${subject}: ${description}`.trim()
          : subject.trim();

        taskMap.set(String(taskId), {
          id: String(taskId),
          content,
          status: 'pending',
        });
      }
    } else if (toolName === 'taskupdate') {
      const taskId = typeof input.taskId === 'string' ? input.taskId : String(input.taskId ?? '');
      if (!taskId || !taskMap.has(taskId)) continue;
      const existing = taskMap.get(taskId)!;

      if (input.status === 'deleted') {
        taskMap.delete(taskId);
        continue;
      }
      if (typeof input.status === 'string') {
        existing.status = normalizeTodoStatus(input.status);
      }
      if (typeof input.subject === 'string' && input.subject.trim()) {
        existing.content = input.subject.trim();
      }

      // addBlocks: this task becomes the blocker for the listed task IDs
      if (Array.isArray(input.addBlocks)) {
        for (const id of input.addBlocks) {
          const blockedId = String(id);
          const blocked = taskMap.get(blockedId);
          if (blocked) {
            if (!blocked.blockedBy) blocked.blockedBy = [];
            if (!blocked.blockedBy.includes(taskId)) {
              blocked.blockedBy.push(taskId);
            }
          }
        }
      }

      // addBlockedBy: this task is blocked by the listed task IDs
      if (Array.isArray(input.addBlockedBy)) {
        if (!existing.blockedBy) existing.blockedBy = [];
        for (const id of input.addBlockedBy) {
          const blockerId = String(id);
          if (!existing.blockedBy.includes(blockerId)) {
            existing.blockedBy.push(blockerId);
          }
        }
      }
    }
  }

  return Array.from(taskMap.values());
}
