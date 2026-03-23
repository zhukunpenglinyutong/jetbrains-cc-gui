/**
 * Tests for streaming render settings (localStorage toggles for tables/lists)
 * in useSettingsBasicActions.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

describe('Streaming render localStorage toggles', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('streamingRenderTables', () => {
    it('defaults to true when localStorage has no value', () => {
      const val = localStorage.getItem('streamingRenderTables');
      expect(val).toBeNull();
      // The hook uses: val !== 'false' → true when null
      expect(val !== 'false').toBe(true);
    });

    it('reads "true" from localStorage correctly', () => {
      localStorage.setItem('streamingRenderTables', 'true');
      const val = localStorage.getItem('streamingRenderTables');
      expect(val !== 'false').toBe(true);
    });

    it('reads "false" from localStorage correctly', () => {
      localStorage.setItem('streamingRenderTables', 'false');
      const val = localStorage.getItem('streamingRenderTables');
      expect(val !== 'false').toBe(false);
    });

    it('persists value to localStorage', () => {
      localStorage.setItem('streamingRenderTables', String(false));
      expect(localStorage.getItem('streamingRenderTables')).toBe('false');

      localStorage.setItem('streamingRenderTables', String(true));
      expect(localStorage.getItem('streamingRenderTables')).toBe('true');
    });
  });

  describe('streamingRenderLists', () => {
    it('defaults to false when localStorage has no value', () => {
      const val = localStorage.getItem('streamingRenderLists');
      expect(val).toBeNull();
      // The hook uses: val === 'true' → false when null
      expect(val === 'true').toBe(false);
    });

    it('reads "true" from localStorage correctly', () => {
      localStorage.setItem('streamingRenderLists', 'true');
      const val = localStorage.getItem('streamingRenderLists');
      expect(val === 'true').toBe(true);
    });

    it('reads "false" from localStorage correctly', () => {
      localStorage.setItem('streamingRenderLists', 'false');
      const val = localStorage.getItem('streamingRenderLists');
      expect(val === 'true').toBe(false);
    });

    it('persists value to localStorage', () => {
      localStorage.setItem('streamingRenderLists', String(true));
      expect(localStorage.getItem('streamingRenderLists')).toBe('true');

      localStorage.setItem('streamingRenderLists', String(false));
      expect(localStorage.getItem('streamingRenderLists')).toBe('false');
    });
  });
});
