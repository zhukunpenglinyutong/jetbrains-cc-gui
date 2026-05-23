import type { ToolInput } from '../types';
import { normalizeToolName } from './toolConstants';
import { normalizeTodoStatus } from './todoShared';
import type { RawTodoItem } from './todoShared';

type EditItem = {
  oldText?: unknown;
  newText?: unknown;
};

type ToolInputRecord = ToolInput & Record<string, unknown>;

function getFirstEdit(input: ToolInputRecord): EditItem | undefined {
  const edits = input.edits;
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const first = edits[0];
  return first && typeof first === 'object' ? first as EditItem : undefined;
}

function normalizePlanEntries(input: ToolInputRecord): ToolInput {
  const plan = Array.isArray(input.plan) ? input.plan : [];
  return {
    ...input,
    plan: plan
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const candidate = item as RawTodoItem;
        const content =
          (typeof candidate.content === 'string' && candidate.content.trim()) ? candidate.content.trim() :
          (typeof candidate.step === 'string' && candidate.step.trim()) ? candidate.step.trim() :
          (typeof candidate.title === 'string' && candidate.title.trim()) ? candidate.title.trim() :
          (typeof candidate.text === 'string' && candidate.text.trim()) ? candidate.text.trim() :
          '';
        if (!content) return null;
        return {
          ...candidate,
          content,
          step: content,
          status: normalizeTodoStatus(candidate.status),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null),
  };
}

function extractPromptFromItems(items: unknown): string | undefined {
  if (!Array.isArray(items)) {
    return undefined;
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text.trim()) {
      return candidate.text;
    }
  }

  return undefined;
}

function normalizeSpawnAgentInput(input: ToolInputRecord): ToolInput {
  const prompt =
    (typeof input.prompt === 'string' && input.prompt.trim()) ? input.prompt :
    (typeof input.message === 'string' && input.message.trim()) ? input.message :
    extractPromptFromItems(input.items);

  const subagentType =
    (typeof input.subagent_type === 'string' && input.subagent_type.trim()) ? input.subagent_type :
    (typeof input.subagentType === 'string' && input.subagentType.trim()) ? input.subagentType :
    (typeof input.agent_type === 'string' && input.agent_type.trim()) ? input.agent_type :
    (typeof input.agentType === 'string' && input.agentType.trim()) ? input.agentType :
    'default';

  return {
    ...input,
    subagent_type: subagentType,
    prompt,
    description:
      (typeof input.description === 'string' && input.description.trim()) ? input.description :
      (typeof input.message === 'string' && input.message.trim()) ? input.message :
      (typeof prompt === 'string' ? prompt : undefined),
  };
}

function normalizeAgentTaskInput(input: ToolInputRecord): ToolInput {
  const prompt =
    (typeof input.prompt === 'string' && input.prompt.trim()) ? input.prompt :
    (typeof input.message === 'string' && input.message.trim()) ? input.message :
    (typeof input.text === 'string' && input.text.trim()) ? input.text :
    extractPromptFromItems(input.items);

  const subagentType =
    (typeof input.subagent_type === 'string' && input.subagent_type.trim()) ? input.subagent_type :
    (typeof input.subagentType === 'string' && input.subagentType.trim()) ? input.subagentType :
    (typeof input.agent === 'string' && input.agent.trim()) ? input.agent :
    (typeof input.agent_type === 'string' && input.agent_type.trim()) ? input.agent_type :
    (typeof input.agentType === 'string' && input.agentType.trim()) ? input.agentType :
    'general';

  return {
    ...input,
    subagent_type: subagentType,
    prompt,
    description:
      (typeof input.description === 'string' && input.description.trim()) ? input.description :
      (typeof input.title === 'string' && input.title.trim()) ? input.title :
      (typeof prompt === 'string' ? prompt : undefined),
  };
}

export function normalizeToolInput(name: string | undefined, input: ToolInput | undefined): ToolInput | undefined {
  if (!input) return input;

  const inputRecord = input as ToolInputRecord;
  const normalizedName = normalizeToolName(name ?? '');
  if (normalizedName === 'edit_file') {
    const firstEdit = getFirstEdit(inputRecord);
    return {
      ...inputRecord,
      file_path:
        (typeof inputRecord.file_path === 'string' ? inputRecord.file_path : undefined) ??
        (typeof inputRecord.filePath === 'string' ? inputRecord.filePath : undefined) ??
        (typeof inputRecord.path === 'string' ? inputRecord.path : undefined),
      old_string:
        (typeof inputRecord.old_string === 'string' ? inputRecord.old_string : undefined) ??
        (typeof inputRecord.oldString === 'string' ? inputRecord.oldString : undefined) ??
        (typeof firstEdit?.oldText === 'string' ? firstEdit.oldText : undefined),
      new_string:
        (typeof inputRecord.new_string === 'string' ? inputRecord.new_string : undefined) ??
        (typeof inputRecord.newString === 'string' ? inputRecord.newString : undefined) ??
        (typeof firstEdit?.newText === 'string' ? firstEdit.newText : undefined),
    };
  }

  if (normalizedName === 'write_file') {
    return {
      ...inputRecord,
      file_path:
        (typeof inputRecord.file_path === 'string' ? inputRecord.file_path : undefined) ??
        (typeof inputRecord.filePath === 'string' ? inputRecord.filePath : undefined) ??
        (typeof inputRecord.path === 'string' ? inputRecord.path : undefined),
      new_string:
        (typeof inputRecord.new_string === 'string' ? inputRecord.new_string : undefined) ??
        (typeof inputRecord.newString === 'string' ? inputRecord.newString : undefined) ??
        (typeof inputRecord.content === 'string' ? inputRecord.content : undefined),
    };
  }

  if (normalizedName === 'update_plan') {
    return normalizePlanEntries(inputRecord);
  }

  if (normalizedName === 'spawn_agent') {
    return normalizeSpawnAgentInput(inputRecord);
  }

  if (normalizedName === 'task' || normalizedName === 'agent') {
    return normalizeAgentTaskInput(inputRecord);
  }

  return inputRecord;
}
