/**
 * T2: TrackerParser regex tests.
 * Mirrors the Java TrackerParser.BUG_PATTERN regex and extractLabel() logic
 * to verify parsing of TRACKER.md table rows with StatusChangedOn column.
 */
import { describe, expect, it } from 'vitest';

// Port of Java regex: ^\\| (B-\\d+) \\| [^|]+ \\| ([^|]+) \\| (open|testing) \\| ([^|]*) \\|
const BUG_PATTERN = /^\| (B-\d+) \| [^|]+ \| ([^|]+) \| (open|testing) \| ([^|]*) \|/;

function extractLabel(description: string): string {
  let trimmed = description.trim();
  trimmed = trimmed.replace(/^\*\*/, '').replace(/\*\*$/, '');
  const dotPos = trimmed.indexOf('.');
  if (dotPos > 0 && dotPos < 80) {
    return trimmed.substring(0, dotPos);
  }
  return trimmed.length > 80 ? trimmed.substring(0, 77) + '...' : trimmed;
}

function parseLine(line: string): { id: string; label: string; status: string; statusChangedOn?: string } | null {
  const m = BUG_PATTERN.exec(line);
  if (!m) return null;
  const bug: { id: string; label: string; status: string; statusChangedOn?: string } = {
    id: m[1],
    label: extractLabel(m[2]),
    status: m[3].trim(),
  };
  const changedOn = m[4].trim();
  if (changedOn && changedOn !== '—') {
    bug.statusChangedOn = changedOn;
  }
  return bug;
}

describe('TrackerParser regex (T2)', () => {
  it('parses open bug with StatusChangedOn', () => {
    const line = '| B-004 | `ChatInputBox` | ArrowUp at very top of contentEditable causes cursor to disappear (Chromium edge case) | open | 2026-02-15 | — | — | — |';
    const bug = parseLine(line);
    expect(bug).not.toBeNull();
    expect(bug!.id).toBe('B-004');
    expect(bug!.status).toBe('open');
    expect(bug!.statusChangedOn).toBe('2026-02-15');
    // Label > 80 chars without early period → truncated
    expect(bug!.label.length).toBe(80);
    expect(bug!.label.startsWith('ArrowUp at very top of contentEditable')).toBe(true);
  });

  it('parses testing bug with StatusChangedOn', () => {
    const line = '| B-021 | Scroll / Streaming | Chat scrolls up abruptly when streaming begins. | testing | 2026-03-10 | jh.10 | upstream (PR #600) | — |';
    const bug = parseLine(line);
    expect(bug).not.toBeNull();
    expect(bug!.id).toBe('B-021');
    expect(bug!.status).toBe('testing');
    expect(bug!.statusChangedOn).toBe('2026-03-10');
  });

  it('ignores fixed bugs', () => {
    const line = '| B-001 | `ChatInputBox` | Spellcheck active | fixed | 2026-02-15 | jh.5 | merged | `fix/branch` |';
    expect(parseLine(line)).toBeNull();
  });

  it('ignores header row', () => {
    const line = '| ID | Component | Description | Status | StatusChangedOn | Since | Upstream | Branch |';
    expect(parseLine(line)).toBeNull();
  });

  it('ignores separator row', () => {
    const line = '|----|-----------|-------------|--------|-----------------|-------|----------|--------|';
    expect(parseLine(line)).toBeNull();
  });

  it('handles em-dash (—) in StatusChangedOn as missing', () => {
    const line = '| B-099 | Test | Some bug description | open | — | — | — | — |';
    const bug = parseLine(line);
    expect(bug).not.toBeNull();
    expect(bug!.statusChangedOn).toBeUndefined();
  });

  it('extracts label up to first period', () => {
    const line = '| B-006 | Scroll | Scroll-to-bottom button does not re-activate. More details here. | open | 2026-02-15 | — | — | — |';
    const bug = parseLine(line);
    expect(bug!.label).toBe('Scroll-to-bottom button does not re-activate');
  });

  it('truncates label at 80 chars when no period', () => {
    const longDesc = 'A'.repeat(100);
    const line = `| B-050 | Test | ${longDesc} | open | 2026-03-01 | — | — | — |`;
    const bug = parseLine(line);
    expect(bug!.label.length).toBe(80);
    expect(bug!.label.endsWith('...')).toBe(true);
  });

  it('strips bold markdown from label', () => {
    const line = '| B-033 | SessionHandler | **"API request failed" when external file is open.** Details. | open | 2026-03-11 | — | — | — |';
    const bug = parseLine(line);
    expect(bug!.label).not.toContain('**');
    expect(bug!.label.startsWith('"API request failed"')).toBe(true);
  });

  it('parses real TRACKER.md line with complex description', () => {
    const line = '| B-028 | Message Rendering / Streaming | Assistant-Antwort erscheint **über** der User-Nachricht statt darunter. Nach dem Absenden scrollt der Stream oberhalb des eigenen Prompts los. | testing | 2026-03-10 | jh.10 | upstream (PR #600, #611) | — |';
    const bug = parseLine(line);
    expect(bug).not.toBeNull();
    expect(bug!.id).toBe('B-028');
    expect(bug!.status).toBe('testing');
    expect(bug!.statusChangedOn).toBe('2026-03-10');
  });
});
