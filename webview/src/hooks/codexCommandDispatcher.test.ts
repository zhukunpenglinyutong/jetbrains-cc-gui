import { describe, expect, it } from 'vitest';
import { parseCodexCommand } from './codexCommandDispatcher';

describe('parseCodexCommand', () => {
  it('classifies bare and body plan commands consistently', () => {
    expect(parseCodexCommand('/plan')).toMatchObject({ kind: 'plan', body: '', hasArguments: false });
    expect(parseCodexCommand('/plan inspect the workspace')).toMatchObject({
      kind: 'plan',
      body: 'inspect the workspace',
      hasArguments: true,
    });
  });

  it('keeps control command arguments visible for usage validation', () => {
    expect(parseCodexCommand('/compact now')).toMatchObject({
      kind: 'compact',
      argumentsText: 'now',
      hasArguments: true,
    });
  });

  it('returns unknown for an unlisted command without swallowing its text', () => {
    expect(parseCodexCommand('/custom arg')).toMatchObject({
      kind: 'unknown',
      command: '/custom',
      argumentsText: 'arg',
    });
  });
});
