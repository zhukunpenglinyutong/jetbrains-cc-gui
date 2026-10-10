import { describe, expect, it } from 'vitest';
import {
  buildCodexElicitationContent,
  buildCodexPermissionApprovalResult,
  buildCodexUserInputAnswers,
} from './useDialogManagement';

describe('buildCodexUserInputAnswers', () => {
  it('uses question ids as keys and always sends string arrays', () => {
    expect(buildCodexUserInputAnswers({
      color: 'blue',
      tools: ['git', 'npm'],
    })).toEqual({
      color: { answers: ['blue'] },
      tools: { answers: ['git', 'npm'] },
    });
  });
});

describe('buildCodexElicitationContent', () => {
  it('preserves special field names as JSON data rather than changing a prototype', () => {
    const answers = JSON.parse('{"__proto__":"value","constructor":"2"}');
    const schema = JSON.parse('{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer"}}}');
    const result = buildCodexElicitationContent(answers, schema);
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse('{"__proto__":"value","constructor":2}'));
  });

  it('converts MCP primitive fields using the requested schema', () => {
    expect(buildCodexElicitationContent({
      name: 'Ada',
      count: '2',
      enabled: 'true',
      tags: ['one', 'two'],
    }, {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
        enabled: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    })).toEqual({ name: 'Ada', count: 2, enabled: true, tags: ['one', 'two'] });
  });
});

describe('buildCodexPermissionApprovalResult', () => {
  it('keeps the requested permission profile and explicit scope', () => {
    expect(buildCodexPermissionApprovalResult({
      permissions: { filesystem: { roots: ['/repo'] }, network: { hosts: ['example.com'] } },
    }, 'turn')).toEqual({
      permissions: { filesystem: { roots: ['/repo'] }, network: { hosts: ['example.com'] } },
      scope: 'turn',
    });
  });

  it('returns an empty grant when the request is denied', () => {
    expect(buildCodexPermissionApprovalResult({}, 'turn')).toEqual({ permissions: {}, scope: 'turn' });
  });
});
