import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialEventState, emitSyntheticPatchOperations } from './codex-event-handler.js';
import { parseApplyPatchToOperations } from './codex-patch-parser.js';

test('parseApplyPatchToOperations emits delete file operations', () => {
  const operations = parseApplyPatchToOperations(`*** Begin Patch
*** Delete File: src/obsolete.ts
*** End Patch`);

  assert.equal(operations.length, 1);
  assert.equal(operations[0].filePath, 'src/obsolete.ts');
  assert.equal(operations[0].kind, 'delete');
  assert.equal(operations[0].toolName, 'edit');
  assert.equal(operations[0].oldString, '');
  assert.equal(operations[0].newString, '');
});

test('delete file patch operations are emitted as visible unsafe file changes', () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));
  const operations = parseApplyPatchToOperations(`*** Begin Patch
*** Delete File: src/obsolete.ts
*** End Patch`);

  const count = emitSyntheticPatchOperations(state, [{ callId: 'delete-1', operations }], false);

  assert.equal(count, 1);
  const use = emitted.find((message) => message.message?.content?.[0]?.type === 'tool_use');
  const result = emitted.find((message) => message.message?.content?.[0]?.type === 'tool_result');
  assert.equal(use.message.content[0].name, 'edit');
  assert.equal(use.message.content[0].input.file_path, 'src/obsolete.ts');
  assert.equal(use.message.content[0].input.safe_to_rollback, false);
  assert.equal(result.message.content[0].is_error, false);
});
