export type HookDiffLineType = 'context' | 'added' | 'removed';

export interface HookDiffLine {
  type: HookDiffLineType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

const LOOKAHEAD_LINES = 80;

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n');
}

function findLine(lines: string[], value: string, start: number): number {
  const end = Math.min(lines.length, start + LOOKAHEAD_LINES);
  for (let index = start; index < end; index += 1) {
    if (lines[index] === value) {
      return index;
    }
  }
  return -1;
}

/** Builds a bounded line diff without quadratic work on large hook files. */
export function buildHookSourceDiff(original: string, draft: string): HookDiffLine[] {
  const oldLines = splitLines(original);
  const newLines = splitLines(draft);
  const result: HookDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];
    if (oldLine === newLine && oldLine !== undefined) {
      result.push({ type: 'context', text: oldLine, oldLine: oldIndex + 1, newLine: newIndex + 1 });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    if (oldLine === undefined) {
      result.push({ type: 'added', text: newLine ?? '', newLine: newIndex + 1 });
      newIndex += 1;
      continue;
    }
    if (newLine === undefined) {
      result.push({ type: 'removed', text: oldLine, oldLine: oldIndex + 1 });
      oldIndex += 1;
      continue;
    }

    const oldLineInNew = findLine(newLines, oldLine, newIndex + 1);
    const newLineInOld = findLine(oldLines, newLine, oldIndex + 1);
    if (oldLineInNew !== -1 && (newLineInOld === -1 || oldLineInNew - newIndex <= newLineInOld - oldIndex)) {
      result.push({ type: 'added', text: newLine, newLine: newIndex + 1 });
      newIndex += 1;
    } else if (newLineInOld !== -1) {
      result.push({ type: 'removed', text: oldLine, oldLine: oldIndex + 1 });
      oldIndex += 1;
    } else {
      result.push({ type: 'removed', text: oldLine, oldLine: oldIndex + 1 });
      result.push({ type: 'added', text: newLine, newLine: newIndex + 1 });
      oldIndex += 1;
      newIndex += 1;
    }
  }

  return result;
}
