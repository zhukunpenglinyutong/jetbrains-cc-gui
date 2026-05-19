import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  clampPermissionDialogTimeoutSeconds,
} from './permissionDialogTimeout';

describe('permission dialog timeout helpers', () => {
  describe('clampPermissionDialogTimeoutSeconds — happy path', () => {
    it('keeps valid timeout values unchanged', () => {
      expect(clampPermissionDialogTimeoutSeconds(120)).toBe(120);
      expect(clampPermissionDialogTimeoutSeconds(60)).toBe(60);
      expect(clampPermissionDialogTimeoutSeconds(1800)).toBe(1800);
    });

    it('accepts numeric strings', () => {
      expect(clampPermissionDialogTimeoutSeconds('120')).toBe(120);
      expect(clampPermissionDialogTimeoutSeconds('  120  ')).toBe(120);
      expect(clampPermissionDialogTimeoutSeconds('3600')).toBe(3600);
    });
  });

  describe('clampPermissionDialogTimeoutSeconds — range clamping', () => {
    it('returns MIN for values strictly below MIN', () => {
      expect(clampPermissionDialogTimeoutSeconds(1)).toBe(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS);
      expect(clampPermissionDialogTimeoutSeconds(29)).toBe(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('returns the exact MIN at the boundary', () => {
      expect(clampPermissionDialogTimeoutSeconds(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS))
        .toBe(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('returns the exact MAX at the boundary', () => {
      expect(clampPermissionDialogTimeoutSeconds(MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS))
        .toBe(MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('returns MAX for values strictly above MAX', () => {
      expect(clampPermissionDialogTimeoutSeconds(3601)).toBe(MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS);
      expect(clampPermissionDialogTimeoutSeconds(99999)).toBe(MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('clamps zero to MIN (zero is below MIN, not invalid)', () => {
      expect(clampPermissionDialogTimeoutSeconds(0)).toBe(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('clamps negative numbers to MIN (intentional — caller asked for a low value)', () => {
      expect(clampPermissionDialogTimeoutSeconds(-1)).toBe(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS);
      expect(clampPermissionDialogTimeoutSeconds(-100)).toBe(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS);
      expect(clampPermissionDialogTimeoutSeconds(-3600)).toBe(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('truncates decimals toward zero before clamping', () => {
      expect(clampPermissionDialogTimeoutSeconds(120.7)).toBe(120);
      expect(clampPermissionDialogTimeoutSeconds(120.4)).toBe(120);
      // -0.5 truncates to -0; -0 < MIN → MIN
      expect(clampPermissionDialogTimeoutSeconds(-0.5)).toBe(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });
  });

  describe('clampPermissionDialogTimeoutSeconds — invalid input falls back to DEFAULT', () => {
    it('rejects undefined', () => {
      expect(clampPermissionDialogTimeoutSeconds(undefined))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('rejects null (would otherwise become 0 via Number)', () => {
      expect(clampPermissionDialogTimeoutSeconds(null))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('rejects NaN', () => {
      expect(clampPermissionDialogTimeoutSeconds(Number.NaN))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('rejects positive and negative Infinity', () => {
      expect(clampPermissionDialogTimeoutSeconds(Number.POSITIVE_INFINITY))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
      expect(clampPermissionDialogTimeoutSeconds(Number.NEGATIVE_INFINITY))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('rejects non-numeric strings', () => {
      expect(clampPermissionDialogTimeoutSeconds('bad'))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
      expect(clampPermissionDialogTimeoutSeconds('120abc'))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('rejects empty and whitespace-only strings', () => {
      expect(clampPermissionDialogTimeoutSeconds(''))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
      expect(clampPermissionDialogTimeoutSeconds('   '))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });

    it('rejects non-primitive types', () => {
      expect(clampPermissionDialogTimeoutSeconds({}))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
      expect(clampPermissionDialogTimeoutSeconds([]))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
      expect(clampPermissionDialogTimeoutSeconds(true))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
      expect(clampPermissionDialogTimeoutSeconds(false))
        .toBe(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
    });
  });
});
