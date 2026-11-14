import { describe, it, expect } from 'vitest';
import {
  normalizeToolName,
  isToolName,
  FILE_MODIFY_TOOL_NAMES,
  EDIT_TOOL_NAMES,
  isNonRenderedToolUse,
} from './toolConstants';

describe('local Promise computations', () => {
  it.each([false, true])('keeps orchestration out of tool rows with streaming=%s', isStreaming => {
    expect(isNonRenderedToolUse({ type: 'tool_use', name: 'Promise.resolve', input: { code: 'Promise.resolve(ALL_TOOLS)' } }, isStreaming)).toBe(true);
    expect(isNonRenderedToolUse({ type: 'tool_use', name: 'exec_command', input: { cmd: 'pwd' } }, isStreaming)).toBe(false);
  });
});

describe('normalizeToolName', () => {
  it('lowercases standard names', () => {
    expect(normalizeToolName('Edit')).toBe('edit');
    expect(normalizeToolName('Write')).toBe('write');
    expect(normalizeToolName('functions.apply_patch')).toBe('apply_patch');
    expect(normalizeToolName('tools.apply_patch')).toBe('apply_patch');
    expect(normalizeToolName('collaboration.spawn_agent')).toBe('spawn_agent');
  });

  it('maps "Search Replace" (Grok UI name) to search_replace', () => {
    expect(normalizeToolName('Search Replace')).toBe('search_replace');
    expect(normalizeToolName('search-replace')).toBe('search_replace');
  });

  it('keeps camelCase tools as concatenated lower (TaskCreate)', () => {
    expect(normalizeToolName('TaskCreate')).toBe('taskcreate');
  });

  it('strips mcp prefix', () => {
    expect(normalizeToolName('mcp__server__Edit')).toBe('edit');
  });
});

describe('FILE_MODIFY_TOOL_NAMES', () => {
  it('recognizes Search Replace aliases as file-modify tools', () => {
    expect(isToolName('Search Replace', FILE_MODIFY_TOOL_NAMES)).toBe(true);
    expect(isToolName('search_replace', FILE_MODIFY_TOOL_NAMES)).toBe(true);
    expect(isToolName('SearchReplace', FILE_MODIFY_TOOL_NAMES)).toBe(true);
    expect(isToolName('str_replace', FILE_MODIFY_TOOL_NAMES)).toBe(true);
  });

  it('still recognizes classic Edit/Write', () => {
    expect(isToolName('Edit', FILE_MODIFY_TOOL_NAMES)).toBe(true);
    expect(isToolName('Write', FILE_MODIFY_TOOL_NAMES)).toBe(true);
  });

  it('recognizes JetBrains MCP file tools with and without their server prefix', () => {
    for (const name of ['create_new_file', 'replace_text_in_file', 'mcp__jetbrains__replace_text_in_file']) {
      expect(isToolName(name, FILE_MODIFY_TOOL_NAMES)).toBe(true);
    }
  });
});

describe('EDIT_TOOL_NAMES', () => {
  it('routes Search Replace to edit tool UI grouping', () => {
    expect(isToolName('Search Replace', EDIT_TOOL_NAMES)).toBe(true);
  });
});
