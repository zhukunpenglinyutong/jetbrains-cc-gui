import { describe, it, expect } from 'vitest';
import {
  normalizeToolName,
  isToolName,
  FILE_MODIFY_TOOL_NAMES,
  EDIT_TOOL_NAMES,
} from './toolConstants';

describe('normalizeToolName', () => {
  it('lowercases standard names', () => {
    expect(normalizeToolName('Edit')).toBe('edit');
    expect(normalizeToolName('Write')).toBe('write');
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
});

describe('EDIT_TOOL_NAMES', () => {
  it('routes Search Replace to edit tool UI grouping', () => {
    expect(isToolName('Search Replace', EDIT_TOOL_NAMES)).toBe(true);
  });
});
