export type HookDiffLineType = 'context' | 'added' | 'removed';

export interface HookDiffLine {
  type: HookDiffLineType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

function splitLines(content: string): string[] {
  return content.split(/\r\n|\n|\r/);
}

function positions(lines: string[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  lines.forEach((line, offset) => {
    const occurrences = index.get(line) ?? [];
    occurrences.push(offset);
    index.set(line, occurrences);
  });
  return index;
}

function findLine(index: Map<string, number[]>, value: string, start: number): number {
  const offsets = index.get(value) ?? [];
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle]! < start) low = middle + 1;
    else high = middle;
  }
  return offsets[low] ?? -1;
}

/** Indexed anchors handle long insertions without repeated scans of the file. */
function logicalDiff(original: string, draft: string): HookDiffLine[] {
  const oldLines = splitLines(original);
  const newLines = splitLines(draft);
  const oldPositions = positions(oldLines);
  const newPositions = positions(newLines);
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

    const oldLineInNew = findLine(newPositions, oldLine, newIndex + 1);
    const newLineInOld = findLine(oldPositions, newLine, oldIndex + 1);
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

function endings(content: string): string[] {
  return content.match(/\r\n|\n|\r/g) ?? [];
}

function endingLabel(value: string | undefined): string {
  return value === '\r\n' ? 'CRLF' : value === '\n' ? 'LF' : value === '\r' ? 'CR' : 'EOF';
}

export function buildHookSourceDiff(original: string, draft: string): HookDiffLine[] {
  const before = endings(original);
  const after = endings(draft);
  return logicalDiff(original, draft).flatMap((line): HookDiffLine[] => {
    if (line.type !== 'context' || before[line.oldLine! - 1] === after[line.newLine! - 1]) return [line];
    return [
      { type: 'removed', text: `${line.text} [${endingLabel(before[line.oldLine! - 1])}]`, oldLine: line.oldLine },
      { type: 'added', text: `${line.text} [${endingLabel(after[line.newLine! - 1])}]`, newLine: line.newLine },
    ];
  });
}

/** Textareas normalize line endings. Keep each unchanged line's original separator. */
export function preserveHookLineEndings(draft: string, original: string): string {
  const before = endings(original);
  const after = endings(draft);
  const crlfCount = before.filter(ending => ending === '\r\n').length;
  const preferred = crlfCount > before.length / 2 ? '\r\n' : before[0] === '\r' ? '\r' : '\n';
  return logicalDiff(original, draft).filter(line => line.type !== 'removed').map(line => {
    const separator = line.newLine! <= after.length
      ? line.type === 'context' ? before[line.oldLine! - 1] || preferred : preferred : '';
    return line.text + separator;
  }).join('');
}
