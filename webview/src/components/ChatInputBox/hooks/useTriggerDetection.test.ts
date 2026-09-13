import { renderHook } from '@testing-library/react';
import { useTriggerDetection } from './useTriggerDetection.js';

const ZWSP = '\u200B'; // zero-width space
const ZWNJ = '\u200C'; // zero-width non-joiner
const BOM = '\uFEFF'; // byte order mark

function detect(text: string, cursorPosition: number = text.length) {
  const { result } = renderHook(() => useTriggerDetection());
  return result.current.detectTrigger(text, cursorPosition);
}

describe('useTriggerDetection', () => {
  describe('slash trigger line-start detection', () => {
    it('triggers for / at the very start of input', () => {
      const trigger = detect('/rev');
      expect(trigger).toEqual({ trigger: '/', query: 'rev', start: 0, end: 4 });
    });

    it('triggers for / at the start of a new line', () => {
      const trigger = detect('hello\n/rev');
      expect(trigger?.trigger).toBe('/');
      expect(trigger?.query).toBe('rev');
    });

    it('does not trigger for / preceded by visible text', () => {
      expect(detect('abc/rev')).toBeNull();
    });

    it('triggers for / preceded only by zero-width IME residue', () => {
      // A stale IME composition can leave invisible characters in the
      // contenteditable; they must not block the slash menu.
      const trigger = detect(`${ZWSP}/rev`);
      expect(trigger?.trigger).toBe('/');
      expect(trigger?.query).toBe('rev');
    });

    it('triggers for / preceded by multiple invisible characters', () => {
      const trigger = detect(`${BOM}${ZWSP}${ZWNJ}/skill`);
      expect(trigger?.trigger).toBe('/');
      expect(trigger?.query).toBe('skill');
    });

    it('triggers for / after newline followed by invisible characters', () => {
      const trigger = detect(`text\n${ZWSP}/cmd`);
      expect(trigger?.trigger).toBe('/');
      expect(trigger?.query).toBe('cmd');
    });

    it('does not trigger when visible text hides behind invisible characters', () => {
      expect(detect(`a${ZWSP}/rev`)).toBeNull();
    });
  });

  describe('hash trigger line-start detection', () => {
    it('triggers for # preceded only by zero-width IME residue', () => {
      const trigger = detect(`${ZWSP}#agent`);
      expect(trigger?.trigger).toBe('#');
      expect(trigger?.query).toBe('agent');
    });

    it('does not trigger for # preceded by visible text', () => {
      expect(detect('abc#agent')).toBeNull();
    });
  });
});
