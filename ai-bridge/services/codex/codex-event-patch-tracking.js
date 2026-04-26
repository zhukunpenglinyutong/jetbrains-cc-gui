import { existsSync } from 'fs';
import { readFile, unlink, writeFile } from 'fs/promises';
import { requestPermissionFromJava } from '../../permission-handler.js';
import { extractPatchFromResponseItemPayload, parseApplyPatchToOperations } from './codex-patch-parser.js';
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from './codex-workspace-snapshot.js';
import { resolveFilePath } from './codex-command-utils.js';
import { SESSION_PATCH_SCAN_MAX_LINES, logDebug, logInfo, logWarn } from './codex-utils.js';

function toolUseMsg(id, name, input) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}

function toolResultMsg(toolUseId, isError, content) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }] } };
}

function syntheticPatchSafeToRollback(operation, rollbackResult = null, deniedByUser = false) {
  if (!operation || typeof operation.newString !== 'string' || operation.newString.length === 0) return false;
  if (deniedByUser && rollbackResult?.success === false) return false;
  return true;
}

export async function collectPatchOperationsFromSession(state, config, ensureSessionFilePath, splitSessionJsonlEntries) {
  const sessionPath = ensureSessionFilePath(state, config.threadId);
  if (!sessionPath) return [];
  let content = '';
  try { content = await readFile(sessionPath, 'utf8'); } catch (error) {
    logDebug('PERM_DEBUG', `Failed to read session file for patch replay: ${sessionPath} ${error?.message || error}`);
    return [];
  }
  if (!content.trim()) return [];

  const lines = splitSessionJsonlEntries(content);
  const startIndex = state.sessionLineCursor > 0
    ? state.sessionLineCursor
    : Math.max(0, lines.length - SESSION_PATCH_SCAN_MAX_LINES);
  const batches = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.type !== 'response_item' || !parsed.payload) continue;

    const payload = parsed.payload;
    const callId = String(payload.call_id ?? payload.id ?? `line_${i}`);
    if (state.processedPatchCallIds.has(callId)) continue;

    const patchText = extractPatchFromResponseItemPayload(payload);
    if (!patchText) continue;

    const operations = parseApplyPatchToOperations(patchText)
      .map((op) => ({ ...op, filePath: resolveFilePath(op.filePath, config.cwd) }))
      .filter((op) => op.filePath && (op.kind === 'delete' || op.oldString !== '' || op.newString !== ''));
    state.processedPatchCallIds.add(callId);
    if (operations.length === 0) continue;
    batches.push({ callId, operations });
  }
  state.sessionLineCursor = lines.length;
  return batches;
}

function buildPermissionInputForPatchOperation(operation) {
  if (!operation || typeof operation !== 'object') return null;
  const isWrite = operation.toolName === 'write' || operation.kind === 'add';
  if (isWrite) {
    return { toolName: 'Write', input: { file_path: operation.filePath, content: operation.newString ?? '' } };
  }
  return {
    toolName: 'Edit',
    input: { file_path: operation.filePath, old_string: operation.oldString ?? '', new_string: operation.newString ?? '', replace_all: false }
  };
}

export async function requestPatchApprovalsViaBridge(patchBatches) {
  const deniedCallIds = new Set();
  if (!Array.isArray(patchBatches) || patchBatches.length === 0) return deniedCallIds;
  for (const batch of patchBatches) {
    if (!batch || !Array.isArray(batch.operations) || batch.operations.length === 0) continue;
    const previewOp = batch.operations[0];
    const requestPayload = buildPermissionInputForPatchOperation(previewOp);
    if (!requestPayload) continue;
    try {
      logInfo('PERM_DEBUG', `Patch approval request: callId=${batch.callId}, tool=${requestPayload.toolName}, file=${previewOp?.filePath || ''}`);
      const allowed = await requestPermissionFromJava(requestPayload.toolName, requestPayload.input);
      logInfo('PERM_DEBUG', `Patch approval decision: callId=${batch.callId}, allowed=${allowed ? 'true' : 'false'}`);
      if (!allowed) deniedCallIds.add(batch.callId);
    } catch (error) {
      logWarn('PERM_DEBUG', `Patch approval bridge failed (callId=${batch.callId}): ${error?.message || error}`);
      deniedCallIds.add(batch.callId);
    }
  }
  return deniedCallIds;
}

function normalizeLineRange(startLine, endLine, content) {
  const lines = content.split('\n');
  const start = Number.isInteger(startLine) && startLine > 0 ? startLine : 1;
  const end = Number.isInteger(endLine) && endLine >= start ? endLine : start;
  const offsets = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    offsets.push(offsets[offsets.length - 1] + lines[i].length + 1);
  }
  const startOffset = offsets[Math.min(start - 1, offsets.length - 1)] ?? 0;
  const endLineIndex = Math.min(end - 1, lines.length - 1);
  const endOffset = (offsets[endLineIndex] ?? content.length) + (lines[endLineIndex]?.length ?? 0);
  return { startOffset, endOffset: Math.min(endOffset, content.length) };
}

export function findUniqueRollbackIndex(currentContent, newString, operation) {
  if (!newString) return -1;
  if (Number.isInteger(operation.startLine) && operation.startLine > 0) {
    const { startOffset, endOffset } = normalizeLineRange(operation.startLine, operation.endLine, currentContent);
    const exactWindow = currentContent.slice(startOffset, endOffset);
    const exactIndex = exactWindow.indexOf(newString);
    if (exactIndex >= 0 && exactWindow.indexOf(newString, exactIndex + 1) < 0) {
      return startOffset + exactIndex;
    }
    const expansion = Math.max(newString.length, 256);
    const windowStart = Math.max(0, startOffset - expansion);
    const windowEnd = Math.min(currentContent.length, endOffset + expansion);
    const local = currentContent.slice(windowStart, windowEnd);
    const localIndex = local.indexOf(newString);
    if (localIndex >= 0 && local.indexOf(newString, localIndex + 1) < 0) {
      return windowStart + localIndex;
    }
  }
  const first = currentContent.indexOf(newString);
  if (first < 0) return -1;
  return currentContent.indexOf(newString, first + 1) < 0 ? first : -1;
}

async function rollbackSinglePatchOperation(operation) {
  if (!operation || typeof operation !== 'object' || !operation.filePath) {
    return { ok: false, reason: 'invalid-operation' };
  }
  const { filePath } = operation;
  const oldString = typeof operation.oldString === 'string' ? operation.oldString : '';
  const newString = typeof operation.newString === 'string' ? operation.newString : '';
  const isAddedFile = operation.kind === 'add' || (operation.toolName === 'write' && oldString === '');

  if (isAddedFile) {
    if (!existsSync(filePath)) return { ok: true, reason: 'file-already-missing' };
    try { await unlink(filePath); return { ok: true, reason: 'file-deleted' }; }
    catch (error) { return { ok: false, reason: error?.message || String(error) }; }
  }
  if (!existsSync(filePath)) return { ok: false, reason: 'file-missing' };
  let currentContent = '';
  try { currentContent = await readFile(filePath, 'utf8'); }
  catch (error) { return { ok: false, reason: error?.message || String(error) }; }
  if (newString === oldString) return { ok: true, reason: 'noop' };
  if (!newString) return { ok: false, reason: 'unsupported-empty-new-string' };
  const index = findUniqueRollbackIndex(currentContent, newString, operation);
  if (index < 0) return { ok: false, reason: 'new-string-not-found-or-ambiguous' };
  const revertedContent = currentContent.slice(0, index) + oldString + currentContent.slice(index + newString.length);
  try { await writeFile(filePath, revertedContent, 'utf8'); return { ok: true, reason: 'replaced' }; }
  catch (error) { return { ok: false, reason: error?.message || String(error) }; }
}

export async function rollbackDeniedPatchBatches(patchBatches, deniedCallIds) {
  const resultByCallId = new Map();
  if (!Array.isArray(patchBatches) || patchBatches.length === 0) return resultByCallId;
  if (!(deniedCallIds instanceof Set) || deniedCallIds.size === 0) return resultByCallId;
  for (const batch of patchBatches) {
    if (!batch || !deniedCallIds.has(batch.callId)) continue;
    const operations = Array.isArray(batch.operations) ? [...batch.operations].reverse() : [];
    const failures = [];
    for (const op of operations) {
      const result = await rollbackSinglePatchOperation(op);
      if (!result.ok) failures.push({ filePath: op?.filePath || '', reason: result.reason });
    }
    resultByCallId.set(batch.callId, { success: failures.length === 0, failures });
  }
  return resultByCallId;
}

export function emitSyntheticPatchOperations(state, patchBatches, isError, deniedCallIds = new Set(), rollbackByCallId = new Map()) {
  if (!Array.isArray(patchBatches) || patchBatches.length === 0) return 0;
  let emittedCount = 0;
  for (const batch of patchBatches) {
    if (!batch || !Array.isArray(batch.operations)) continue;
    batch.operations.forEach((op, index) => {
      const toolUseId = `codex_patch_${batch.callId}_${index}`;
      const toolName = op.toolName === 'write' ? 'write' : 'edit';
      if (!state.emittedToolUseIds.has(toolUseId)) {
        state.syntheticEditSequence = (state.syntheticEditSequence || 0) + 1;
        const editSequence = state.syntheticEditSequence;
        state.emitMessage(toolUseMsg(toolUseId, toolName, {
          file_path: op.filePath,
          old_string: op.oldString,
          new_string: op.newString,
          start_line: op.startLine,
          end_line: op.endLine,
          replace_all: false,
          source: 'codex_session_patch',
          operation_id: toolUseId,
          safe_to_rollback: syntheticPatchSafeToRollback(op, rollbackByCallId instanceof Map ? rollbackByCallId.get(batch.callId) : null, deniedCallIds instanceof Set && deniedCallIds.has(batch.callId)),
          edit_sequence: editSequence,
          existed_before: op.kind !== 'add',
          expected_after_content_hash: op.expectedAfterContentHash
        }));
        state.emittedToolUseIds.add(toolUseId);
      }
      if (op.filePath) state.emittedFileChangePaths.add(op.filePath);
      const deniedByUser = deniedCallIds instanceof Set && deniedCallIds.has(batch.callId);
      const rollbackResult = rollbackByCallId instanceof Map ? rollbackByCallId.get(batch.callId) : null;
      const rollbackSucceeded = !deniedByUser || rollbackResult?.success !== false;
      const opIsError = !!isError || (deniedByUser && rollbackSucceeded);
      let resultText = 'Patch applied';
      if (isError) resultText = 'Patch apply failed';
      else if (deniedByUser) {
        resultText = rollbackSucceeded ? 'Patch denied by user and rolled back' : 'Patch denied by user but rollback failed';
      }
      state.emitMessage(toolResultMsg(toolUseId, opIsError, resultText));
      emittedCount += 1;
    });
  }
  return emittedCount;
}

export async function captureTurnWorkspaceSnapshot(state, config) {
  if (state.turnWorkspaceSnapshot || !config?.cwd) return;
  state.turnWorkspaceSnapshot = await captureWorkspaceSnapshot(config.cwd);
  if (state.turnWorkspaceSnapshot?.truncated) {
    logWarn('PERM_DEBUG', `Codex workspace snapshot truncated for cwd=${config.cwd}`);
  }
}

function emitSyntheticWorkspaceSnapshotOperations(state, operations) {
  if (!Array.isArray(operations) || operations.length === 0) return 0;

  const operationsByPath = new Map();
  for (const operation of operations) {
    if (!operation?.filePath) continue;
    const list = operationsByPath.get(operation.filePath) ?? [];
    list.push(operation);
    operationsByPath.set(operation.filePath, list);
  }

  let emittedCount = 0;
  for (const [filePath, fileOperations] of operationsByPath.entries()) {
    if (state.emittedFileChangePaths.has(filePath)) continue;

    fileOperations.forEach((operation) => {
      state.syntheticEditSequence = (state.syntheticEditSequence || 0) + 1;
      const editSequence = state.syntheticEditSequence;
      const toolUseId = `codex_fs_${state.eventStateId || 'state'}_${editSequence}`;
      const toolName = operation.toolName === 'write' ? 'write' : 'edit';

      if (!state.emittedToolUseIds.has(toolUseId)) {
        state.emitMessage(toolUseMsg(toolUseId, toolName, {
          file_path: operation.filePath,
          old_string: operation.oldString,
          new_string: operation.newString,
          start_line: operation.startLine,
          end_line: operation.endLine,
          replace_all: operation.replaceAll === true,
          source: 'codex_session_patch',
          operation_id: toolUseId,
          safe_to_rollback: operation.safeToRollback === true,
          edit_sequence: editSequence,
          existed_before: operation.existedBefore !== false,
          expected_after_content_hash: operation.expectedAfterContentHash
        }));
        state.emittedToolUseIds.add(toolUseId);
      }
      state.emitMessage(toolResultMsg(toolUseId, false, 'Filesystem change detected'));
      state.emittedToolResultIds.add(toolUseId);
      emittedCount += 1;
    });

    state.emittedFileChangePaths.add(filePath);
  }
  return emittedCount;
}

export async function emitTurnWorkspaceDiff(state, config) {
  if (!state.turnWorkspaceSnapshot || !config?.cwd) return 0;
  const afterSnapshot = await captureWorkspaceSnapshot(config.cwd);
  const operations = diffWorkspaceSnapshots(state.turnWorkspaceSnapshot, afterSnapshot);
  const emitted = emitSyntheticWorkspaceSnapshotOperations(state, operations);
  if (emitted > 0) logDebug('CODEX_EVENT', `workspace snapshot synthesized operations=${emitted}`);
  return emitted;
}
