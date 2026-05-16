import { describe, expect, it } from 'vitest';
import { isEditableEventTarget } from './isEditableEventTarget';

describe('isEditableEventTarget', () => {
  it('returns false for null target', () => {
    expect(isEditableEventTarget(null)).toBe(false);
  });

  it('returns false for non-HTMLElement targets (e.g. window)', () => {
    expect(isEditableEventTarget(window)).toBe(false);
  });

  it('returns true for INPUT elements', () => {
    const input = document.createElement('input');
    expect(isEditableEventTarget(input)).toBe(true);
  });

  it('returns true for TEXTAREA elements', () => {
    const textarea = document.createElement('textarea');
    expect(isEditableEventTarget(textarea)).toBe(true);
  });

  it('returns true for SELECT elements', () => {
    const select = document.createElement('select');
    expect(isEditableEventTarget(select)).toBe(true);
  });

  it('returns true for contenteditable elements', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    expect(isEditableEventTarget(div)).toBe(true);
  });

  it('returns false for ordinary block elements (DIV without contenteditable)', () => {
    const div = document.createElement('div');
    expect(isEditableEventTarget(div)).toBe(false);
  });

  it('returns false for BUTTON elements (focused buttons should still receive Enter)', () => {
    const button = document.createElement('button');
    expect(isEditableEventTarget(button)).toBe(false);
  });
});
